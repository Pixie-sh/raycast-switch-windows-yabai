// TypeScript
import {
  Action,
  ActionPanel,
  closeMainWindow,
  getApplications,
  Icon,
  Keyboard,
  LaunchType,
  List,
  LocalStorage,
} from "@raycast/api";
import { getFavicon } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Application, BrowserTab, BrowserType, SortMethod, YabaiWindow } from "./models";
import {
  handleAggregateToSpace,
  handleCloseEmptySpaces,
  handleCloseWindow,
  handleFocusWindow,
  handleOpenWindowInNewSpace,
  handleFocusBrowserTab,
  handleCloseBrowserTab,
  launchApplicationByPath,
  launchApplicationByName,
} from "./handlers";
import {
  DisperseOnDisplayActions,
  MoveToDisplaySpace,
  MoveWindowToDisplayActions,
  InteractiveMoveToDisplayAction,
  MoveToFocusedDisplayAction,
  SpaceManagementActions,
} from "./display-actions-yabai";
import Fuse from "fuse.js";
import { IncompleteJsonError } from "./utils/json";
import { yabaiQueryManager } from "./utils/yabaiQueryManager";
import { browserTabManager } from "./utils/browserTabManager";
import { focusHistoryManager, getMergedFocusTimes } from "./utils/focusHistoryManager";
import { parseDisplayFilter } from "./utils/displayFilter";
import { getDefaultSelectedItemId, searchItems } from "./utils/searchUtils";
import type { SearchField } from "./utils/searchUtils";

/**
 * Parse tab search prefix from search text
 * Format: @<search_term> or just @ for all tabs
 * Example: "@github" searches tabs with "github" in title/URL
 */
function parseTabFilter(searchText: string): {
  hasTabFilter: boolean;
  remainingSearchText: string;
} {
  const trimmed = searchText.trim();
  if (trimmed.startsWith("@")) {
    return {
      hasTabFilter: true,
      remainingSearchText: trimmed.slice(1).trim(),
    };
  }
  return {
    hasTabFilter: false,
    remainingSearchText: searchText,
  };
}

/**
 * Get browser icon source based on browser type
 */
function getBrowserIcon(browser: BrowserType): string {
  switch (browser) {
    case BrowserType.SAFARI:
      return "safari";
    case BrowserType.FIREFOX:
      return "firefox";
    default:
      return "globe"; // Chrome and other Chromium-based browsers
  }
}

const WINDOW_SEARCH_FIELDS: SearchField<YabaiWindow>[] = [
  { getValue: (window) => window.app, priority: 0 },
  { getValue: (window) => window.title, priority: 1 },
];

const APPLICATION_SEARCH_FIELDS: SearchField<Application>[] = [
  { getValue: (application) => application.name, priority: 0 },
];

const TAB_SEARCH_FIELDS: SearchField<BrowserTab>[] = [
  { getValue: (tab) => tab.title, priority: 0 },
  { getValue: (tab) => tab.domain, priority: 1 },
  { getValue: (tab) => tab.url, priority: 2 },
];

const SEARCH_WEB_ITEM_ID = "search-web";

function getWindowItemId(windowId: number): string {
  return `window-${windowId}`;
}

function getApplicationItemId(application: Application): string {
  return `app-${application.path || application.name}`;
}

function getTabItemId(tabId: string): string {
  return `tab-${tabId}`;
}

// Custom hook for debounced search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    // Set debouncedValue to value after the specified delay
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    // Cancel the timeout if value changes or component unmounts
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Utility function to get unique display numbers from windows
function getAvailableDisplayNumbers(windows: YabaiWindow[]): number[] {
  if (!Array.isArray(windows)) return [];

  const displayNumbers = windows
    .map((win) => win.display)
    .filter((display): display is number => display !== undefined && display !== null)
    .sort((a, b) => a - b);

  return [...new Set(displayNumbers)];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function Command(_props: { launchContext?: { launchType: LaunchType } }) {
  const [usageTimes, setUsageTimes] = useState<Record<string, number>>({});
  const [inputText, setInputText] = useState("");
  const searchText = useDebounce(inputText, 30); // Reduced debounce delay for better responsiveness
  const tabFilter = useMemo(() => parseTabFilter(searchText), [searchText]);
  const displayFilter = useMemo(() => parseDisplayFilter(searchText), [searchText]);
  const hasActiveSearch = searchText.trim().length > 0;
  const [windows, setWindows] = useState<YabaiWindow[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [sortMethod, setSortMethod] = useState<SortMethod>(SortMethod.RECENTLY_USED);
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);

  // Focus history to track current and previous focused windows.
  // Stores both window ID and app name: ID is used within the same yabai session
  // (stable IDs), app name is the cross-session fallback (IDs reset on reboot/restart).
  const [focusHistory, setFocusHistory] = useState<{
    current: number | null;
    currentApp: string | null;
    previous: number | null;
    previousApp: string | null;
  }>({ current: null, currentApp: null, previous: null, previousApp: null });

  // Browser tabs state
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const tabsLoadedRef = useRef(false);

  // Focus tracking state - merges extension usage with yabai focus history
  const [mergedFocusTimes, setMergedFocusTimes] = useState<Record<number, number>>({});
  const [isFocusTrackingSetup, setIsFocusTrackingSetup] = useState<boolean | null>(null);
  const [isMergedFocusTimesReady, setIsMergedFocusTimesReady] = useState(false);
  // True once focusHistory has been loaded from LocalStorage on mount.
  // Used to gate the spinner: we must not show the sorted list until we know
  // previousApp, otherwise sortedWindows step 2 runs with null and puts the
  // wrong window at position 1.
  const [isFocusHistoryLoaded, setIsFocusHistoryLoaded] = useState(false);

  // Auto-select countdown state — mimics Cmd+Tab release behavior.
  // Uses exponential backoff: quick switch (1 Tab) is fast, more cycling = more thinking time.
  // delay = min(BASE * BACKOFF^(cycles-1), MAX)
  const AUTO_SELECT_BASE = 1050;
  const AUTO_SELECT_BACKOFF = 1.4;
  const AUTO_SELECT_MAX = 3000;
  const AUTO_SELECT_GIVE_UP = 6; // After this many Tab presses, cancel countdown entirely
  const autoSelectCancelledRef = useRef(false);
  const [autoSelectCountdown, setAutoSelectCountdown] = useState<number | null>(null);

  // Tab-cycling state — controlled via Tab / Shift+Tab actions within the open extension.
  // Starts at index 0 (first item highlighted). Cycling starts the auto-select countdown.
  const [cycleIndex, setCycleIndex] = useState(0);
  // Total Tab presses (never wraps). Used for exponential backoff so it doesn't
  // reset when cycleIndex wraps back to 0.
  const totalTabPressesRef = useRef(0);

  // Refs to track lazy loading state

  // Ref that always holds the latest focusHistory.current value.
  // Used inside refreshWindows so we can read it without putting focusHistory.current
  // in the useCallback dep array (which would recreate refreshWindows/refreshAllData
  // and re-trigger the "Initial refresh" effect on every focus change).
  const focusHistoryCurrentRef = useRef<number | null>(null);

  // Keep the ref in sync whenever focusHistory.current changes.
  useEffect(() => {
    focusHistoryCurrentRef.current = focusHistory.current;
  }, [focusHistory.current]);

  // Function to remove a window from the local listing after it's closed.
  const removeWindow = useCallback((id: number) => {
    setWindows((prevWindows) => prevWindows.filter((w) => w.id !== id));
  }, []);

  const updateFocusHistory = useCallback((windowsData: YabaiWindow[]) => {
    const currentlyFocused = windowsData.find((win) => win["has-focus"] === true);
    const currentFocusedId = currentlyFocused?.id || null;
    const currentFocusedApp = currentlyFocused?.app || null;

    setFocusHistory((prevHistory) => {
      if (currentFocusedId !== prevHistory.current) {
        // Only promote current→previous when we have a known current window.
        // If prevHistory.current is null (e.g. first update before LocalStorage loaded),
        // keep the persisted previous/previousApp so the cross-session fallback survives.
        const newPrevious = prevHistory.current !== null ? prevHistory.current : prevHistory.previous;
        const newPreviousApp = prevHistory.current !== null ? prevHistory.currentApp : prevHistory.previousApp;
        return {
          current: currentFocusedId,
          currentApp: currentFocusedApp,
          previous: newPrevious,
          previousApp: newPreviousApp,
        };
      }
      return prevHistory;
    });
  }, []);

  // Use a ref to prevent simultaneous refreshes without causing dependency issues
  const isRefreshingRef = useRef(false);

  // Function to refresh windows data with focus change detection

  const refreshWindows = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (_forceFull = false) => {
      // Don't refresh if already refreshing
      if (isRefreshingRef.current) return;

      isRefreshingRef.current = true;
      setIsRefreshing(true);
      try {
        try {
          const windowsData = await yabaiQueryManager.queryWindows();
          // Check if focus has changed
          const currentlyFocused = windowsData.find((win) => win["has-focus"] === true);
          const newFocusedId = currentlyFocused?.id || null;
          const previousFocusedId = focusHistoryCurrentRef.current;

          // Always update the windows data to keep the list current
          setWindows(windowsData);

          // Update focus history if changed
          if (newFocusedId !== previousFocusedId) {
            updateFocusHistory(windowsData);
            if (previousFocusedId !== null || newFocusedId !== null) {
              console.log(`Focus changed from window ${previousFocusedId} to ${newFocusedId}`);
            }
          }

          // Update cache with timestamp
          const cacheData = {
            windows: windowsData,
            timestamp: Date.now(),
          };
          await LocalStorage.setItem("cachedWindows", JSON.stringify(cacheData));
          setLastRefreshTime(Date.now());
        } catch (parseError) {
          if (parseError instanceof IncompleteJsonError) {
            // yabai output seems incomplete; skip update and keep previous data
            console.warn("Incomplete windows JSON from yabai; keeping previous data");
          } else {
            console.error("Error parsing windows data:", parseError);
          }
        }
      } catch (error) {
        console.error("Error refreshing windows:", error);
      } finally {
        setIsRefreshing(false);
        isRefreshingRef.current = false;
      }
    },
    [updateFocusHistory],
  );

  // Function to refresh all data (windows only)
  const refreshAllData = useCallback(
    async (forceFull = true) => {
      setIsRefreshing(true);
      try {
        await refreshWindows(forceFull);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refreshWindows],
  );

  // Load previous usage times, sort method, and focus history from local storage when the component mounts.
  useEffect(() => {
    (async () => {
      const storedTimes = await LocalStorage.getItem<string>("usageTimes");
      if (storedTimes) {
        try {
          setUsageTimes(JSON.parse(storedTimes));
        } catch (e) {
          console.error("error setting stored times;", e);
        }
      }

      const storedSortMethod = await LocalStorage.getItem<string>("sortMethod");
      if (storedSortMethod) {
        try {
          const parsedSortMethod = JSON.parse(storedSortMethod);
          setSortMethod(parsedSortMethod as SortMethod);
        } catch {
          setSortMethod(SortMethod.USAGE);
        }
      }

      const storedFocusHistory = await LocalStorage.getItem<string>("focusHistory");
      if (storedFocusHistory) {
        try {
          const parsedFocusHistory = JSON.parse(storedFocusHistory);
          setFocusHistory(parsedFocusHistory);
        } catch (e) {
          console.error("error setting stored focus history;", e);
        }
      }

      // Mark focus history as loaded regardless of whether storage had a value.
      // The spinner stays on until this is true, ensuring sortedWindows step 2
      // runs with the correct previousApp before the list is shown.
      setIsFocusHistoryLoaded(true);
    })();
  }, []);

  // Persist usage times in local storage when they change (debounced to reduce I/O)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      LocalStorage.setItem("usageTimes", JSON.stringify(usageTimes));
    }, 500); // Debounce for 500ms

    return () => clearTimeout(timeoutId);
  }, [usageTimes]);

  // Persist sort method in local storage when it changes (debounced to reduce I/O)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      LocalStorage.setItem("sortMethod", JSON.stringify(sortMethod));
    }, 500); // Debounce for 500ms

    return () => clearTimeout(timeoutId);
  }, [sortMethod]);

  // Persist focus history in local storage when it changes (debounced to reduce I/O)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      LocalStorage.setItem("focusHistory", JSON.stringify(focusHistory));
    }, 500); // Debounce for 500ms

    return () => clearTimeout(timeoutId);
  }, [focusHistory]);

  // Check if focus tracking is set up (yabai signal installed)
  // Also invalidate cache on mount to get fresh focus history from yabai log
  useEffect(() => {
    // Invalidate cache to ensure we read fresh data from yabai log
    focusHistoryManager.invalidateCache();
    focusHistoryManager.isSetupComplete().then(setIsFocusTrackingSetup);
  }, []);

  // Merge extension usage times with yabai focus history for accurate sorting
  // Re-runs when windows change OR when lastRefreshTime changes (indicating fresh window data)
  useEffect(() => {
    if (windows.length === 0) return;

    // Invalidate cache before merging to ensure we have latest yabai focus history
    focusHistoryManager.invalidateCache();

    const windowIds = windows.map((w) => w.id);
    getMergedFocusTimes(usageTimes, windowIds).then((merged) => {
      setMergedFocusTimes(merged);
      setIsMergedFocusTimesReady(true);
      console.log("Merged focus times ready:", JSON.stringify(merged));
    });
  }, [windows, usageTimes, lastRefreshTime]);

  // Query windows using useExec - only for initial load
  // Disable useExec for windows; rely on yabaiQueryManager instead

  // Load cached windows on mount
  useEffect(() => {
    const loadCachedWindows = async () => {
      const cachedData = await LocalStorage.getItem<string>("cachedWindows");
      if (cachedData) {
        try {
          const { windows: cachedWindows, timestamp } = JSON.parse(cachedData);
          if (Array.isArray(cachedWindows) && cachedWindows.length > 0) {
            setWindows(cachedWindows);
            // Do NOT call updateFocusHistory here: focusHistory hasn't been loaded from
            // LocalStorage yet (the storage load effect is async and may not have settled),
            // so updateFocusHistory would see prevHistory.current === null and wipe the
            // persisted previous/previousApp. The real refreshWindows call (triggered by
            // the mount effect) will call updateFocusHistory with fresh yabai data after
            // storage has had time to load.
            setLastRefreshTime(timestamp);
            console.log("Loaded windows from cache, timestamp:", new Date(timestamp).toLocaleString());
          }
        } catch (error) {
          console.error("Error parsing cached windows:", error);
        }
      }
    };

    loadCachedWindows();
  }, []);

  // Initial refresh when extension opens + eagerly load browser tabs
  useEffect(() => {
    let isMounted = true;

    const initialize = async () => {
      if (!isMounted) return;
      console.log("Extension mounted, refreshing all data");

      // 1. Show cached tabs instantly (from previous session's LocalStorage)
      browserTabManager.loadCachedTabs().then((cached) => {
        if (isMounted && cached && cached.length > 0) {
          setBrowserTabs(cached);
          tabsLoadedRef.current = true;
          console.log(`Loaded ${cached.length} cached browser tabs instantly`);
        }
      });

      // 2. Refresh tabs from browsers in background (no yabai dependency)
      browserTabManager
        .queryAllTabs()
        .then((tabs) => {
          if (isMounted && tabs.length > 0) {
            setBrowserTabs(tabs);
            tabsLoadedRef.current = true;
            console.log(`Refreshed ${tabs.length} browser tabs from browsers`);
          }
        })
        .catch(() => {});

      // 3. Refresh windows from yabai
      await refreshAllData(true);
    };

    initialize();

    return () => {
      isMounted = false;
    };
  }, [refreshAllData]); // Include refreshAllData in dependencies

  // No background polling - rely on manual refresh to avoid flickering

  // Load applications on mount using native getApplications()
  useEffect(() => {
    let isMounted = true;
    getApplications()
      .then((apps) => {
        if (isMounted) {
          setApplications(apps.map((a) => ({ name: a.name, path: a.path })));
        }
      })
      .catch((error) => console.error("Error loading applications:", error));
    return () => {
      isMounted = false;
    };
  }, []);

  // Create a Fuse instance for fuzzy searching windows
  const fuse = useMemo(() => {
    if (!Array.isArray(windows) || windows.length === 0) return null;
    return new Fuse(windows, {
      keys: [
        { name: "app", weight: 3 }, // Give app name highest weight
        { name: "title", weight: 1 }, // Lower weight for title
      ],
      includeScore: true,
      threshold: 0.4, // Lower threshold for stricter matching
      ignoreLocation: true, // Search the entire string, not just from the beginning
      useExtendedSearch: true, // Enable extended search for more powerful queries
      sortFn: (a, b) => {
        // Custom sort function to prioritize app matches over title matches
        if (a.score === b.score) {
          // If scores are equal, prioritize shorter app names (more precise)
          const aAppLength = (a.item.app || "").toString().length;
          const bAppLength = (b.item.app || "").toString().length;
          return aAppLength - bAppLength;
        }
        return a.score - b.score; // Lower score is better
      },
    });
  }, [windows]);

  // Create a Fuse instance for fuzzy searching applications
  const appFuse = useMemo(() => {
    if (!Array.isArray(applications) || applications.length === 0) return null;
    return new Fuse(applications, {
      keys: ["name"],
      includeScore: true,
      threshold: 0.3, // Even stricter threshold for applications
      ignoreLocation: true,
      useExtendedSearch: true,
      sortFn: (a, b) => {
        // Custom sort function to prioritize exact matches
        if (a.score === b.score) {
          // If scores are equal, prioritize shorter names (more precise)
          const aNameLength = (a.item.name || "").toString().length;
          const bNameLength = (b.item.name || "").toString().length;
          return aNameLength - bNameLength;
        }
        return a.score - b.score; // Lower score is better
      },
    });
  }, [applications]);

  // Set searching state when input text changes and refresh on first search
  useEffect(() => {
    if (inputText.trim() && inputText !== searchText) {
      setIsSearching(true);
    } else {
      setIsSearching(false);
    }
  }, [inputText, searchText]);

  // Helper function to load browser tabs (lazy loaded)
  const loadBrowserTabs = useCallback(async () => {
    if (tabsLoadedRef.current) return;

    setIsLoadingTabs(true);
    tabsLoadedRef.current = true;

    try {
      const tabs = await browserTabManager.queryAllTabs();
      setBrowserTabs(tabs);
      console.log(`Loaded ${tabs.length} browser tabs`);
    } catch (error) {
      console.error("Error loading browser tabs:", error);
    } finally {
      setIsLoadingTabs(false);
    }
  }, []);

  // Create Fuse instance for browser tabs
  const tabFuse = useMemo(() => {
    if (!Array.isArray(browserTabs) || browserTabs.length === 0) return null;
    return new Fuse(browserTabs, {
      keys: [
        { name: "title", weight: 3 },
        { name: "domain", weight: 2 },
        { name: "url", weight: 1 },
      ],
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      useExtendedSearch: true,
    });
  }, [browserTabs]);

  // Filter browser tabs based on search text (Spotlight-like behavior)
  // @ prefix = show ONLY tabs, otherwise show tabs along with windows/apps
  const filteredTabs = useMemo(() => {
    if (!Array.isArray(browserTabs) || browserTabs.length === 0) return [];

    // Determine the effective search text
    const effectiveSearch = tabFilter.hasTabFilter ? tabFilter.remainingSearchText : searchText;

    // If @ with no search term, return all tabs
    // If no search at all (empty), don't show tabs (only show when searching)
    if (tabFilter.hasTabFilter && !effectiveSearch.trim()) return browserTabs;
    if (!effectiveSearch.trim()) return [];

    // Skip tabs if display filter is active (tabs don't have displays)
    if (displayFilter.hasDisplayFilter && !tabFilter.hasTabFilter) return [];

    return searchItems({
      items: browserTabs,
      query: effectiveSearch,
      fields: TAB_SEARCH_FIELDS,
      fuse: tabFuse,
    });
  }, [
    browserTabs,
    displayFilter.hasDisplayFilter,
    searchText,
    tabFilter.hasTabFilter,
    tabFilter.remainingSearchText,
    tabFuse,
  ]);

  // Trigger lazy loading when user starts typing or uses @ prefix
  const prevInputLengthRef = useRef(0);
  useEffect(() => {
    const prevLength = prevInputLengthRef.current;
    const currentLength = inputText.length;

    // Only trigger when going from 0 to 1+ characters (user just started typing)
    if (prevLength === 0 && currentLength >= 1) {
      console.log("User started searching, triggering lazy loads");

      // Refresh windows
      refreshWindows(false);

      // Lazy load browser tabs
      loadBrowserTabs();
    }

    // Also load tabs if user types @ (tab filter) even from empty state
    if (inputText.startsWith("@") && !tabsLoadedRef.current) {
      loadBrowserTabs();
    }

    prevInputLengthRef.current = currentLength;
  }, [inputText, refreshWindows, loadBrowserTabs]);

  // Cache for display-filtered Fuse instances to avoid recreating them
  const displayFilteredFuseCache = useRef<Map<string, Fuse<YabaiWindow>>>(new Map());

  // Filter windows based on the search text using fuzzy search with display filtering support
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    if (!searchText.trim()) return windows; // Return all windows if search text is empty

    // Special case: if search text is just "#" without a number, keep all windows
    if (searchText.trim() === "#") return windows;

    // Apply display filter first if present (Precedence: Display filter → Text search)
    // This approach ensures optimal performance by reducing the search space early
    let windowsToSearch = windows;
    if (displayFilter.hasDisplayFilter && displayFilter.displayNumber !== null) {
      windowsToSearch = windows.filter((win) => win.display === displayFilter.displayNumber);

      // Early return if no windows found on specified display
      if (windowsToSearch.length === 0) {
        return [];
      }

      // If only display filter (no additional search text), return all windows on that display
      // This handles cases like "#3" where user wants all windows on display 3
      if (!displayFilter.remainingSearchText.trim()) {
        return windowsToSearch;
      }
    }

    // If no additional search text after display filter, return filtered windows
    const effectiveSearchText = displayFilter.hasDisplayFilter ? displayFilter.remainingSearchText : searchText;
    if (!effectiveSearchText.trim()) {
      return windowsToSearch;
    }

    // Get or create a Fuse instance for the filtered window set
    // Use caching to avoid recreating Fuse instances for the same display
    let searchFuse = fuse;
    if (displayFilter.hasDisplayFilter && displayFilter.displayNumber !== null && windowsToSearch !== windows) {
      if (windowsToSearch.length > 0) {
        const cacheKey = `display-${displayFilter.displayNumber}-${windowsToSearch.length}`;
        let cachedFuse = displayFilteredFuseCache.current.get(cacheKey);

        if (!cachedFuse) {
          cachedFuse = new Fuse(windowsToSearch, {
            keys: [
              { name: "app", weight: 3 }, // Give app name highest weight
              { name: "title", weight: 1 }, // Lower weight for title
            ],
            includeScore: true,
            threshold: 0.4, // Maintain same search sensitivity
            ignoreLocation: true,
            useExtendedSearch: true,
            sortFn: (a, b) => {
              if (a.score === b.score) {
                const aAppLength = (a.item.app || "").toString().length;
                const bAppLength = (b.item.app || "").toString().length;
                return aAppLength - bAppLength;
              }
              return a.score - b.score;
            },
          });
          displayFilteredFuseCache.current.set(cacheKey, cachedFuse);

          // Limit cache size to prevent memory leaks
          if (displayFilteredFuseCache.current.size > 10) {
            const firstKey = displayFilteredFuseCache.current.keys().next().value;
            if (firstKey) {
              displayFilteredFuseCache.current.delete(firstKey);
            }
          }
        }
        searchFuse = cachedFuse;
      } else {
        searchFuse = null;
      }
    }

    if (!searchFuse) return [];

    return searchItems({
      items: windowsToSearch,
      query: effectiveSearchText,
      fields: WINDOW_SEARCH_FIELDS,
      fuse: searchFuse,
    });
  }, [
    displayFilter.displayNumber,
    displayFilter.hasDisplayFilter,
    displayFilter.remainingSearchText,
    fuse,
    searchText,
    windows,
  ]);

  // Filter applications based on the search text using fuzzy search
  const filteredApplications = useMemo(() => {
    if (!Array.isArray(applications)) return [];
    if (!searchText.trim()) return applications; // Return all applications if search text is empty

    // Special case: if search text is just "#" without a number, keep all applications
    if (searchText.trim() === "#") return applications;

    if (!appFuse) return [];
    return searchItems({
      items: applications,
      query: searchText,
      fields: APPLICATION_SEARCH_FIELDS,
      fuse: appFuse,
    });
  }, [applications, searchText, appFuse]);

  // Sort windows based on selected sort method.
  // Uses mergedFocusTimes which combines extension usage with yabai focus history
  const sortedWindows = useMemo(() => {
    const windowsCopy = [...filteredWindows];
    const hasWindowSearchQuery = displayFilter.hasDisplayFilter
      ? displayFilter.remainingSearchText.trim().length > 0
      : searchText.trim().length > 0;

    if (hasWindowSearchQuery) {
      return windowsCopy;
    }

    // Step 1: sort by focus time, with the currently-focused window always first.
    windowsCopy.sort((a, b) => {
      const aFocused = a["has-focus"] || a.focused;
      const bFocused = b["has-focus"] || b.focused;
      if (aFocused && !bFocused) return -1;
      if (!aFocused && bFocused) return 1;

      // Use merged focus times (includes yabai focus history for external focus changes)
      // Falls back to usageTimes if merged data not yet available
      const timeA = mergedFocusTimes[a.id] || usageTimes[a.id] || 0;
      const timeB = mergedFocusTimes[b.id] || usageTimes[b.id] || 0;
      return timeB - timeA;
    });

    // Step 2: explicitly place the previous window at position 1 (index 1).
    // First try to find it by ID (reliable within the same yabai session).
    // If that fails (IDs reset on reboot/restart), fall back to app name match.
    // This ensures the "Alt+Tab previous" window is always at #2.
    const prevId = focusHistory.previous;
    const prevApp = focusHistory.previousApp;
    if (windowsCopy.length > 1 && (prevId !== null || prevApp !== null)) {
      let prevIdx = prevId !== null ? windowsCopy.findIndex((w) => w.id === prevId) : -1;
      // Cross-session fallback: match by app name when ID is stale
      if (prevIdx === -1 && prevApp !== null) {
        prevIdx = windowsCopy.findIndex((w) => w.app === prevApp && !(w["has-focus"] || w.focused));
      }
      // Only move it if it exists, isn't already at position 1, and isn't the focused one
      if (prevIdx > 1) {
        const [prevWin] = windowsCopy.splice(prevIdx, 1);
        windowsCopy.splice(1, 0, prevWin);
      }
    }

    // Debug: log sorted order
    if (windowsCopy.length > 0 && isMergedFocusTimesReady) {
      console.log(
        "Sorted windows order:",
        windowsCopy.slice(0, 5).map((w) => `${w.id}:${w.app}(${mergedFocusTimes[w.id] || 0})`),
      );
    }

    return windowsCopy;
  }, [
    filteredWindows,
    mergedFocusTimes,
    usageTimes,
    isMergedFocusTimesReady,
    focusHistory.previous,
    focusHistory.previousApp,
    displayFilter.hasDisplayFilter,
    displayFilter.remainingSearchText,
    searchText,
  ]);

  // Tab-cycling: select the window at the current cycle index.
  // First open = index 0, each subsequent Tab press increments.
  const altTabSelectedWindow = useMemo(() => {
    if (sortedWindows.length === 0) return undefined;
    const effectiveIndex = cycleIndex % sortedWindows.length;
    return sortedWindows[effectiveIndex];
  }, [sortedWindows, cycleIndex]);

  // Cycle callbacks for Tab / Shift+Tab actions
  const cycleNext = useCallback(() => {
    if (sortedWindows.length === 0) return;
    totalTabPressesRef.current += 1;
    setCycleIndex((prev) => (prev + 1) % sortedWindows.length);
  }, [sortedWindows.length]);

  const cyclePrev = useCallback(() => {
    if (sortedWindows.length === 0) return;
    totalTabPressesRef.current += 1;
    setCycleIndex((prev) => (prev - 1 + sortedWindows.length) % sortedWindows.length);
  }, [sortedWindows.length]);

  // Cancel auto-select permanently when the user types anything
  useEffect(() => {
    if (inputText.length > 0 && !autoSelectCancelledRef.current) {
      autoSelectCancelledRef.current = true;
      // Also reset cycle index since the user is now searching
      setCycleIndex(0);
    }
  }, [inputText]);

  // Ref that always holds the latest altTabSelectedWindow so the timer
  // callback can read it without stale closures.
  const altTabSelectedWindowRef = useRef(altTabSelectedWindow);
  useEffect(() => {
    altTabSelectedWindowRef.current = altTabSelectedWindow;
  }, [altTabSelectedWindow]);

  // Auto-select countdown — only activates after the first Tab press (cycleIndex >= 1).
  // Uses exponential backoff: more cycling = longer delay (user is unsure).
  // cycleIndex 1 → 750ms, 2 → 1050ms, 3 → 1470ms, 4 → 2058ms, 5+ → capped at 3000ms.
  // React cleanup handles clearing timers on each re-run.
  useEffect(() => {
    if (autoSelectCancelledRef.current) return;
    if (!isMergedFocusTimesReady || !isFocusHistoryLoaded) return;
    if (!altTabSelectedWindow) return;
    if (inputText.length > 0) return;
    if (totalTabPressesRef.current < 1) return;

    const presses = totalTabPressesRef.current;
    // Too many cycles = user is undecided, stop pressuring them
    if (presses >= AUTO_SELECT_GIVE_UP) {
      console.log(`${presses} presses: auto-select disabled (too indecisive)`);
      autoSelectCancelledRef.current = true;
      return;
    }
    const delay = Math.min(Math.round(AUTO_SELECT_BASE * Math.pow(AUTO_SELECT_BACKOFF, presses - 1)), AUTO_SELECT_MAX);

    console.log(`Cycle ${cycleIndex} (${presses} total presses): auto-select delay = ${delay}ms`);

    // Visual countdown (updates every 250ms)
    const startTime = Date.now();
    setAutoSelectCountdown(delay);
    const interval = setInterval(() => {
      const remaining = Math.max(0, delay - (Date.now() - startTime));
      setAutoSelectCountdown(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 250);

    // Actual auto-select timer
    const timer = setTimeout(async () => {
      const win = altTabSelectedWindowRef.current;
      if (!win || autoSelectCancelledRef.current) {
        setAutoSelectCountdown(null);
        return;
      }

      console.log(`Auto-select countdown fired, switching to ${win.app} (${win.id})`);

      const now = Date.now();
      const prevId = focusHistory.current;
      const prevApp = focusHistory.currentApp;
      setFocusHistory({ current: win.id, currentApp: win.app, previous: prevId, previousApp: prevApp });
      setUsageTimes((prev) => ({ ...prev, [win.id]: now }));
      focusHistoryManager.recordFocus(win.id);

      const focusAction = handleFocusWindow(
        win.id,
        win.app,
        () => {
          closeMainWindow();
        },
        applications,
      );
      await focusAction();

      setAutoSelectCountdown(null);
    }, delay);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      setAutoSelectCountdown(null);
    };
  }, [cycleIndex, isMergedFocusTimesReady, isFocusHistoryLoaded]);

  const searchWebQuery = tabFilter.remainingSearchText.trim();
  const shouldShowSearchWebResult =
    !(isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded) &&
    sortedWindows.length === 0 &&
    filteredApplications.length === 0 &&
    filteredTabs.length === 0 &&
    searchWebQuery.length > 0;

  const visibleItemIds = useMemo(() => {
    const itemIds: string[] = [];

    if (!tabFilter.hasTabFilter) {
      itemIds.push(...sortedWindows.map((window) => getWindowItemId(window.id)));
      itemIds.push(...filteredApplications.map((application) => getApplicationItemId(application)));
    }

    itemIds.push(...filteredTabs.map((tab) => getTabItemId(tab.id)));

    if (shouldShowSearchWebResult) {
      itemIds.push(SEARCH_WEB_ITEM_ID);
    }

    return itemIds;
  }, [filteredApplications, filteredTabs, shouldShowSearchWebResult, sortedWindows, tabFilter.hasTabFilter]);

  const selectedItemId = useMemo(() => {
    return getDefaultSelectedItemId({
      hasSearchText: hasActiveSearch,
      emptySearchItemId: altTabSelectedWindow ? getWindowItemId(altTabSelectedWindow.id) : undefined,
      visibleItemIds,
    });
  }, [altTabSelectedWindow, hasActiveSearch, visibleItemIds]);

  // No need for focus/blur detection anymore since we only refresh on mount

  // Get available display numbers for filtering actions
  const availableDisplays = useMemo(() => getAvailableDisplayNumbers(windows), [windows]);

  return (
    <List
      isLoading={isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded}
      onSearchTextChange={setInputText}
      searchBarPlaceholder="Search windows, apps, and browser tabs... (#3 for display, @ for tabs only)"
      filtering={false} // Disable built-in filtering since we're using Fuse.js
      throttle={false} // Disable throttling for more responsive search
      selectedItemId={selectedItemId}
      actions={
        <ActionPanel>
          <Action
            title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
            onAction={() => refreshAllData(true)}
            shortcut={Keyboard.Shortcut.Common.Refresh}
          />
          {isFocusTrackingSetup === false && (
            <Action.OpenInBrowser
              title="Setup Focus Tracking"
              url={`file://${focusHistoryManager.getHistoryDirPath()}`}
              shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
            />
          )}
          <Action
            title={isLoadingTabs ? "Refreshing Tabs…" : "Refresh Browser Tabs"}
            onAction={() => {
              tabsLoadedRef.current = false;
              browserTabManager.invalidateCache();
              setIsLoadingTabs(true);
              browserTabManager
                .queryAllTabs()
                .then((tabs) => {
                  setBrowserTabs(tabs);
                  tabsLoadedRef.current = true;
                })
                .finally(() => setIsLoadingTabs(false));
            }}
            shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
          />
          <ActionPanel.Section title="Space Management">
            <SpaceManagementActions />
          </ActionPanel.Section>
          <ActionPanel.Section title="Display Filters">
            <Action
              title="Clear Filter"
              onAction={() => setInputText("")}
              shortcut={{ modifiers: ["opt", "ctrl"], key: "0" }}
            />
            {availableDisplays.slice(0, 9).map((displayNum) => (
              <Action
                key={`filter-display-${displayNum}`}
                title={`Filter Display #${displayNum}`}
                onAction={() => setInputText(`#${displayNum}`)}
                shortcut={{ modifiers: ["opt", "ctrl"], key: String(displayNum) as never }}
              />
            ))}
          </ActionPanel.Section>
          <ActionPanel.Section title="Yabai">
            <Action.OpenInBrowser
              title="Open Yabai Documentation"
              url="https://github.com/koekeishiya/yabai/wiki"
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      {sortedWindows.length > 0 && !tabFilter.hasTabFilter && (
        <List.Section
          title={(() => {
            return displayFilter.hasDisplayFilter && displayFilter.displayNumber !== null
              ? `Windows (Display #${displayFilter.displayNumber})`
              : "Windows";
          })()}
          subtitle={(() => {
            const count = sortedWindows.length.toString();
            if (autoSelectCountdown !== null && autoSelectCountdown > 0) {
              return `${count} · auto-switching in ${(autoSelectCountdown / 1000).toFixed(1)}s`;
            }
            return count;
          })()}
        >
          {sortedWindows.map((win) => (
            <List.Item
              key={win.id}
              id={getWindowItemId(win.id)}
              icon={{
                ...getAppIcon(win, applications),
                tintColor: win["has-focus"] || win.focused ? "#10b981" : undefined,
              }}
              title={`${win["has-focus"] || win.focused ? "• " : ""}${win.app}`}
              subtitle={win.title}
              accessories={[
                { tag: { value: `#${win.display || "?"}`, color: getDisplayColor(win.display) } },
                ...(win["has-focus"] || win.focused ? [{ tag: { value: "focused", color: "#fbbf24" } }] : []),
              ]}
              keywords={win["has-focus"] || win.focused ? ["focused", "current"] : []}
              actions={
                <WindowActions
                  windowId={win.id}
                  windowApp={win.app}
                  windowTitle={win.title}
                  isFocused={win["has-focus"] || win.focused}
                  onFocused={(id) => {
                    const now = Date.now();
                    const prevId = focusHistory.current;
                    const prevApp = focusHistory.currentApp;

                    // Update focus history: the window we're leaving becomes "previous",
                    // the window we're switching to becomes "current".
                    // Both ID and app name are stored: ID works within the same yabai session;
                    // app name is the cross-session fallback when IDs reset (reboot/restart).
                    setFocusHistory({ current: id, currentApp: win.app, previous: prevId, previousApp: prevApp });

                    setUsageTimes((prev) => {
                      const updated: Record<string, number> = { ...prev, [id]: now };
                      return updated;
                    });
                    // Also record focus in yabai history for external tracking
                    focusHistoryManager.recordFocus(id);
                    // closeMainWindow() is called here for the already-focused window
                    // shortcut path (isFocused === true, no yabai command is run).
                    // For the normal focus path, handleFocusWindow calls closeMainWindow()
                    // *before* the yabai command to prevent the race condition where
                    // Raycast snaps focus back to the original space/display.
                    closeMainWindow();
                  }}
                  onRemove={removeWindow}
                  setSortMethod={setSortMethod}
                  onRefresh={refreshAllData}
                  isRefreshing={isRefreshing}
                  applications={applications}
                  setInputText={setInputText}
                  windows={windows}
                  onCycleNext={cycleNext}
                  onCyclePrev={cyclePrev}
                />
              }
            />
          ))}
        </List.Section>
      )}

      {filteredApplications.length > 0 && !tabFilter.hasTabFilter && (
        <List.Section title="Applications" subtitle={filteredApplications.length.toString()}>
          {filteredApplications.map((app) => (
            <List.Item
              key={app.path}
              id={getApplicationItemId(app)}
              icon={{ fileIcon: app.path }}
              title={app.name}
              actions={
                <ActionPanel>
                  <Action
                    title="Open Application"
                    onAction={async () => {
                      try {
                        await closeMainWindow();
                        if (app.path) {
                          await launchApplicationByPath(app.path);
                        } else {
                          await launchApplicationByName(app.name);
                        }
                      } catch {
                        // fallback: try by name if path launch failed
                        try {
                          await launchApplicationByName(app.name);
                        } catch (e) {
                          console.error("Failed to open application:", e);
                        }
                      }
                    }}
                  />
                  <Action
                    title="Open in New Space"
                    onAction={handleOpenWindowInNewSpace(-1, app.name)}
                    shortcut={{ modifiers: ["opt"], key: "enter" }}
                  />
                  <Action
                    title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
                    onAction={() => refreshAllData(true)}
                    shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
                  />
                  <ActionPanel.Section title="Display Filters">
                    <Action
                      title="Clear Filter"
                      onAction={() => setInputText("")}
                      shortcut={{ modifiers: ["opt", "ctrl"], key: "0" }}
                    />
                    {availableDisplays.slice(0, 9).map((displayNum) => (
                      <Action
                        key={`app-filter-display-${displayNum}`}
                        title={`Filter Display #${displayNum}`}
                        onAction={() => setInputText(`#${displayNum}`)}
                        shortcut={{ modifiers: ["opt", "ctrl"], key: String(displayNum) as never }}
                      />
                    ))}
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {filteredTabs.length > 0 && (
        <List.Section title="Browser Tabs" subtitle={filteredTabs.length.toString()}>
          {filteredTabs.map((tab) => (
            <List.Item
              key={tab.id}
              id={getTabItemId(tab.id)}
              icon={
                tab.url && !tab.url.startsWith("about:") && !tab.url.startsWith("chrome://")
                  ? getFavicon(tab.url, { fallback: getBrowserIcon(tab.browser) })
                  : { source: getBrowserIcon(tab.browser), fallback: Icon.Globe }
              }
              title={tab.title || "Untitled"}
              subtitle={tab.domain}
              accessories={[
                { tag: { value: tab.browser.split(" ")[0], color: getBrowserColor(tab.browser) } },
                ...(tab.isActive ? [{ tag: { value: "active", color: "#10b981" } }] : []),
              ]}
              actions={
                <ActionPanel>
                  <Action title="Switch to Tab" onAction={handleFocusBrowserTab(tab, () => closeMainWindow())} />
                  <Action.CopyToClipboard
                    title="Copy URL"
                    content={tab.url}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action
                    title="Close Tab"
                    onAction={handleCloseBrowserTab(tab, () => {
                      setBrowserTabs((prev) => prev.filter((t) => t.id !== tab.id));
                    })}
                    shortcut={{ modifiers: ["cmd", "ctrl"], key: "w" }}
                  />
                  <Action
                    title="Refresh Tabs"
                    onAction={() => {
                      tabsLoadedRef.current = false;
                      browserTabManager.invalidateCache();
                      setIsLoadingTabs(true);
                      browserTabManager
                        .queryAllTabs()
                        .then(setBrowserTabs)
                        .finally(() => setIsLoadingTabs(false));
                    }}
                    shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
                  />
                  <Action
                    title="Clear Tab Filter"
                    onAction={() => setInputText("")}
                    shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {shouldShowSearchWebResult && (
        <List.Item
          id={SEARCH_WEB_ITEM_ID}
          key={SEARCH_WEB_ITEM_ID}
          icon={Icon.MagnifyingGlass}
          title={`Search "${searchWebQuery}" on Web`}
          subtitle="Open in default browser"
          actions={
            <ActionPanel>
              <Action.OpenInBrowser
                title="Search on Google"
                url={`https://www.google.com/search?q=${encodeURIComponent(searchWebQuery)}`}
              />
              <Action.OpenInBrowser
                title="Search on Duckduckgo"
                url={`https://duckduckgo.com/?q=${encodeURIComponent(searchWebQuery)}`}
                shortcut={{ modifiers: ["cmd"], key: "d" }}
              />
              <Action
                title="Clear Search"
                onAction={() => setInputText("")}
                shortcut={{ modifiers: ["cmd"], key: "backspace" }}
              />
            </ActionPanel>
          }
        />
      )}

      {!(isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded) &&
        !shouldShowSearchWebResult &&
        sortedWindows.length === 0 &&
        filteredApplications.length === 0 &&
        filteredTabs.length === 0 && (
          <List.EmptyView
            title={tabFilter.hasTabFilter ? "No Browser Tabs Found" : "No Windows or Applications Found"}
            description={
              tabFilter.hasTabFilter
                ? "No tabs match your search. Make sure browsers are running and Raycast has automation permissions."
                : "No windows or applications were found."
            }
          />
        )}
    </List>
  );
}

function WindowActions({
  windowId,
  windowApp,
  windowTitle,
  onFocused,
  onRemove,
  setSortMethod,
  onRefresh,
  isRefreshing,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isFocused,
  applications = [],
  setInputText,
  windows,
  onCycleNext,
  onCyclePrev,
}: {
  windowId: number;
  windowApp: string;
  windowTitle: string;
  onFocused: (id: number) => void;
  onRemove: (id: number) => void;
  setSortMethod: (method: SortMethod) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  isFocused?: boolean;
  applications?: Application[];
  setInputText: (text: string) => void;
  windows: YabaiWindow[];
  onCycleNext: () => void;
  onCyclePrev: () => void;
}) {
  const availableDisplays = useMemo(() => getAvailableDisplayNumbers(windows), [windows]);
  return (
    <ActionPanel>
      <Action title="Switch to Window" onAction={handleFocusWindow(windowId, windowApp, onFocused, applications)} />
      <Action
        title="Open in New Space"
        onAction={handleOpenWindowInNewSpace(windowId, windowApp)}
        shortcut={{ modifiers: ["opt"], key: "enter" }}
      />
      <Action
        title="Aggregate to Space"
        onAction={handleAggregateToSpace(windowId, windowApp)}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "m" }}
      />
      <Action
        title="Close Window"
        onAction={handleCloseWindow(windowId, windowApp, onRemove)}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "w" }}
      />
      <Action
        title="Close Empty Spaces"
        onAction={handleCloseEmptySpaces(windowId, onRemove)}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "q" }}
      />
      <Action
        title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
        onAction={onRefresh}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
      />
      <ActionPanel.Section title="Display Actions">
        <MoveToFocusedDisplayAction windowId={windowId} windowApp={windowApp} />
        <InteractiveMoveToDisplayAction windowId={windowId} windowApp={windowApp} windowTitle={windowTitle} />
        <DisperseOnDisplayActions />
        <MoveWindowToDisplayActions windowId={windowId} windowApp={windowApp} />
        <MoveToDisplaySpace windowId={windowId} windowApp={windowApp} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Space Management">
        <SpaceManagementActions />
      </ActionPanel.Section>
      <ActionPanel.Section title="Display Filters">
        <Action
          title="Clear Filter"
          onAction={() => setInputText("")}
          shortcut={{ modifiers: ["opt", "ctrl"], key: "0" }}
        />
        {availableDisplays.slice(0, 9).map((displayNum) => (
          <Action
            key={`filter-display-${displayNum}`}
            title={`Filter Display #${displayNum}`}
            onAction={() => setInputText(`#${displayNum}`)}
            shortcut={{ modifiers: ["opt", "ctrl"], key: String(displayNum) as never }}
          />
        ))}
      </ActionPanel.Section>
      <ActionPanel.Section title="Cycle">
        <Action title="Next Window" onAction={onCycleNext} shortcut={{ modifiers: [], key: "tab" }} />
        <Action title="Previous Window" onAction={onCyclePrev} shortcut={{ modifiers: ["shift"], key: "tab" }} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Sort by">
        <Action title="Sort by Previous" onAction={() => setSortMethod(SortMethod.RECENTLY_USED)} />
        <Action title="Sort by Usage" onAction={() => setSortMethod(SortMethod.USAGE)} />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function getDisplayColor(displayIndex: number | undefined): string {
  // Define lighter, subtle colors for different displays
  const colors = [
    "#93c5fd", // Light blue for display 1
    "#86efac", // Light green for display 2
    "#fca5a5", // Light red for display 3
    "#c4b5fd", // Light purple for display 4
    "#fdba74", // Light orange for display 5
    "#67e8f9", // Light cyan for display 6
  ];

  if (!displayIndex || displayIndex < 1) {
    return "#d1d5db"; // Light grey for unknown display
  }

  // Use modulo to cycle through colors if more than 6 displays
  return colors[(displayIndex - 1) % colors.length];
}

function getBrowserColor(browser: BrowserType): string {
  switch (browser) {
    case BrowserType.CHROME:
      return "#4285f4"; // Google blue
    case BrowserType.SAFARI:
      return "#007aff"; // Apple blue
    case BrowserType.VIVALDI:
      return "#ef3939"; // Vivaldi red
    case BrowserType.BRAVE:
      return "#fb542b"; // Brave orange
    case BrowserType.EDGE:
      return "#0078d7"; // Microsoft blue
    case BrowserType.ARC:
      return "#ff4f8b"; // Arc pink
    case BrowserType.FIREFOX:
      return "#ff7139"; // Firefox orange
    default:
      return "#6b7280"; // Grey for unknown
  }
}

function getAppIcon(window: YabaiWindow, applications: Application[]) {
  const appName = window.app;

  const foundApp = applications.find((app) => app.name === appName);
  if (foundApp) {
    return { fileIcon: foundApp.path };
  }

  return { source: Icon.Window };
}
