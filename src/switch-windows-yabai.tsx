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
import { getFavicon, showFailureToast, useLocalStorage } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Application, BrowserTab, BrowserType, SortMethod, YabaiWindow } from "./models";
import {
  handleFocusWindow,
  handleOpenWindowInNewSpace,
  handleFocusBrowserTab,
  handleCloseBrowserTab,
  launchApplicationByPath,
  launchApplicationByName,
} from "./handlers";
import {
  MoveWindowToDisplayActions,
  InteractiveMoveToDisplayAction,
  MoveToFocusedDisplayAction,
  SpaceManagementActions,
} from "./display-actions-yabai";
import Fuse from "fuse.js";
import { IncompleteJsonError } from "./utils/json";
import { parseCalcMode, evaluateExpression } from "./utils/calc";
import { yabaiQueryManager } from "./utils/yabaiQueryManager";
import { browserTabManager } from "./utils/browserTabManager";
import { focusHistoryManager, getMergedFocusTimes } from "./utils/focusHistoryManager";
import { parseDisplayFilter } from "./utils/displayFilter";
import { getDefaultSelectedItemId, searchItems } from "./utils/searchUtils";
import { canCloseBrowserTab } from "./utils/browserTabData";
import { parseCachedWindows } from "./utils/runtimeData";
import {
  advanceFocusState,
  FocusState,
  getCycledIndex,
  getCycleOriginForSelection,
  getWindowSetKey,
  hydrateWindowState,
  makeFocusReference,
  migrateFocusState,
  recordWindowUsage,
  resolveCountdownTarget,
  resolveFocusReference,
  resolveVisibleSelection,
  serializeFocusState,
  serializeUsageStorage,
  shouldSyncFocusHistory,
  sortWindows as sortWindowsByMethod,
  UsageEntry,
} from "./utils/windowState";
import type { SearchField } from "./utils/searchUtils";
import { runBestEffort } from "./utils/bestEffort";
import { shouldShowWebFallbackForScope } from "./utils/searchScope";
import { LoadingActivityCounter } from "./utils/trailingQuery";

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
const CALC_RESULT_ITEM_ID = "calc-result";
const CACHED_WINDOWS_MAX_AGE_MS = 10_000;

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
  const [usageTimes, setUsageTimes] = useState<Record<string, UsageEntry>>({});
  const [inputText, setInputText] = useState("");
  const searchText = useDebounce(inputText, 30); // Reduced debounce delay for better responsiveness
  const tabFilter = useMemo(() => parseTabFilter(searchText), [searchText]);
  const displayFilter = useMemo(() => parseDisplayFilter(searchText), [searchText]);
  const calcMode = useMemo(() => parseCalcMode(searchText), [searchText]);
  const calcResult = useMemo(() => (calcMode.isCalcMode ? evaluateExpression(calcMode.expression) : null), [calcMode]);
  const hasActiveSearch = searchText.trim().length > 0;
  const [windows, setWindows] = useState<YabaiWindow[]>([]);
  const [hasFreshWindowData, setHasFreshWindowData] = useState(false);
  const [applications, setApplications] = useState<Application[]>([]);
  const { value: storedSortMethod, setValue: setSortMethod } = useLocalStorage<SortMethod>(
    "sortMethod",
    SortMethod.RECENTLY_USED,
  );
  const sortMethod = storedSortMethod ?? SortMethod.RECENTLY_USED;
  const { value: _isShowingDetail, setValue: setIsShowingDetail } = useLocalStorage<boolean>("isShowingDetail", false);
  const isShowingDetail = _isShowingDetail ?? false;
  const [scopeFilter, setScopeFilter] = useState<"all" | "windows" | "applications" | "tabs">("all");
  const effectiveTabFilter = useMemo(() => {
    if (scopeFilter === "tabs") {
      const remainingSearchText = tabFilter.hasTabFilter ? tabFilter.remainingSearchText : searchText.trim();
      return { hasTabFilter: true, remainingSearchText };
    }
    return tabFilter;
  }, [scopeFilter, tabFilter, searchText]);
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);

  const [focusHistory, setFocusHistory] = useState<FocusState>({ current: null, previous: null });
  const storageWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueStorageWrite = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = storageWriteQueueRef.current.then(operation, operation);
    storageWriteQueueRef.current = next;
    return next;
  }, []);

  // Browser tabs state
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const tabsLoadedRef = useRef(false);
  const tabLoadingCounterRef = useRef(new LoadingActivityCounter());
  const beginTabLoading = useCallback(() => setIsLoadingTabs(tabLoadingCounterRef.current.begin()), []);
  const endTabLoading = useCallback(() => setIsLoadingTabs(tabLoadingCounterRef.current.end()), []);

  // Focus tracking state - merges extension usage with yabai focus history
  const [mergedFocusTimes, setMergedFocusTimes] = useState<Record<number, number>>({});
  const [isFocusTrackingSetup, setIsFocusTrackingSetup] = useState<boolean | null>(null);
  const [isMergedFocusTimesReady, setIsMergedFocusTimesReady] = useState(false);
  // Gate sorting until persisted focus references are hydrated.
  const [isFocusHistoryLoaded, setIsFocusHistoryLoaded] = useState(false);
  const isFocusHistoryLoadedRef = useRef(false);

  // Auto-select countdown state — mimics Cmd+Tab release behavior.
  // Allow another Tab press without making later selections progressively slower.
  const AUTO_SELECT_DELAY_MS = 250;
  const AUTO_SELECT_GIVE_UP = 6; // After this many Tab presses, cancel countdown entirely
  const autoSelectCancelledRef = useRef(false);
  const [autoSelectCountdown, setAutoSelectCountdown] = useState<number | null>(null);

  // Tab-cycling state — controlled via Tab / Shift+Tab actions within the open extension.
  // Starts at index 0 (first item highlighted). Cycling starts the auto-select countdown.
  const [cycleIndex, setCycleIndex] = useState(0);
  const cycleIndexRef = useRef(0);
  const [userSelectedItemId, setUserSelectedItemId] = useState<string>();
  const selectedItemIdRef = useRef<string | undefined>(undefined);
  // Total Tab presses (never wraps). Used for exponential backoff so it doesn't
  // reset when cycleIndex wraps back to 0.
  const totalTabPressesRef = useRef(0);

  const focusHistoryCurrentRef = useRef(focusHistory.current);

  useEffect(() => {
    focusHistoryCurrentRef.current = focusHistory.current;
  }, [focusHistory.current]);

  const updateFocusHistory = useCallback((windowsData: YabaiWindow[]) => {
    const focusedWindow = windowsData.find((window) => window["has-focus"] === true);
    const nextReference = focusedWindow ? makeFocusReference(focusedWindow) : null;
    setFocusHistory((previousState) => {
      const migratedState = migrateFocusState(previousState, windowsData);
      if (
        nextReference?.id === migratedState.current?.id &&
        nextReference?.fingerprint === migratedState.current?.fingerprint
      ) {
        return migratedState;
      }
      const validCurrent = resolveFocusReference(migratedState.current, windowsData);
      return {
        current: nextReference,
        previous: validCurrent ? makeFocusReference(validCurrent) : migratedState.previous,
      };
    });
  }, []);

  const refreshActivityCountRef = useRef(0);
  const beginRefreshActivity = useCallback(() => {
    refreshActivityCountRef.current += 1;
    setIsRefreshing(true);
  }, []);
  const endRefreshActivity = useCallback(() => {
    refreshActivityCountRef.current = Math.max(0, refreshActivityCountRef.current - 1);
    setIsRefreshing(refreshActivityCountRef.current > 0);
  }, []);

  // Function to refresh windows data with focus change detection

  const refreshWindows = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (_forceFull = false) => {
      beginRefreshActivity();
      try {
        try {
          const windowsData = await yabaiQueryManager.queryWindows();
          const currentlyFocused = windowsData.find((win) => win["has-focus"] === true);
          const newFocusedReference = currentlyFocused ? makeFocusReference(currentlyFocused) : null;
          const previousFocusedReference = focusHistoryCurrentRef.current;

          setWindows(windowsData);
          setHasFreshWindowData(true);

          if (
            isFocusHistoryLoadedRef.current &&
            (newFocusedReference?.id !== previousFocusedReference?.id ||
              newFocusedReference?.fingerprint !== previousFocusedReference?.fingerprint)
          ) {
            updateFocusHistory(windowsData);
          }

          // Update cache with timestamp
          const cacheData = {
            windows: windowsData,
            timestamp: Date.now(),
          };
          await runBestEffort(
            () => LocalStorage.setItem("cachedWindows", JSON.stringify(cacheData)),
            (error) => console.warn("Could not persist window cache:", error),
          );
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
        endRefreshActivity();
      }
    },
    [beginRefreshActivity, endRefreshActivity, updateFocusHistory],
  );

  const refreshApplications = useCallback(async () => {
    const apps = await getApplications();
    setApplications(apps.map((app) => ({ name: app.name, path: app.path })));
  }, []);

  const refreshAllData = useCallback(
    async (forceFull = true) => {
      beginRefreshActivity();
      try {
        if (forceFull) yabaiQueryManager.invalidateCache();
        await Promise.all([refreshWindows(forceFull), refreshApplications()]);
      } finally {
        endRefreshActivity();
      }
    },
    [beginRefreshActivity, endRefreshActivity, refreshApplications, refreshWindows],
  );

  useEffect(() => {
    void (async () => {
      const hydrated = await hydrateWindowState((key) => LocalStorage.getItem<string>(key));
      setUsageTimes(hydrated.usageTimes);
      setFocusHistory(hydrated.focusHistory);
      focusHistoryCurrentRef.current = hydrated.focusHistory.current;
      if (hydrated.error) console.error("Failed to hydrate focus state:", hydrated.error);
      isFocusHistoryLoadedRef.current = true;
      setIsFocusHistoryLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!shouldSyncFocusHistory(isFocusHistoryLoaded, hasFreshWindowData)) return;
    updateFocusHistory(windows);
  }, [hasFreshWindowData, isFocusHistoryLoaded, updateFocusHistory, windows]);

  useEffect(() => {
    if (!isFocusHistoryLoaded) return;
    void runBestEffort(
      () => enqueueStorageWrite(() => LocalStorage.setItem("usageTimes", serializeUsageStorage(usageTimes))),
      (error) => console.warn("Could not persist usage history:", error),
    );
  }, [enqueueStorageWrite, isFocusHistoryLoaded, usageTimes]);

  useEffect(() => {
    if (!isFocusHistoryLoaded) return;
    void runBestEffort(
      () => enqueueStorageWrite(() => LocalStorage.setItem("focusHistory", serializeFocusState(focusHistory))),
      (error) => console.warn("Could not persist focus history:", error),
    );
  }, [enqueueStorageWrite, focusHistory, isFocusHistoryLoaded]);

  useEffect(() => {
    focusHistoryManager.invalidateCache();
    focusHistoryManager.isSetupComplete().then(setIsFocusTrackingSetup);
  }, []);

  const mergeGenerationRef = useRef(0);
  useEffect(() => {
    if (!isFocusHistoryLoaded) return;
    const generation = ++mergeGenerationRef.current;
    if (windows.length === 0) {
      setMergedFocusTimes({});
      setIsMergedFocusTimesReady(true);
      return;
    }
    setIsMergedFocusTimesReady(false);
    focusHistoryManager.invalidateCache();
    getMergedFocusTimes(usageTimes, windows)
      .then((merged) => {
        if (generation !== mergeGenerationRef.current) return;
        setMergedFocusTimes(merged);
        setIsMergedFocusTimesReady(true);
      })
      .catch((error) => {
        if (generation !== mergeGenerationRef.current) return;
        console.error("Failed to merge focus history:", error);
        setMergedFocusTimes({});
        setIsMergedFocusTimesReady(true);
      });
  }, [isFocusHistoryLoaded, lastRefreshTime, usageTimes, windows]);

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

    beginTabLoading();
    tabsLoadedRef.current = true;

    try {
      const tabs = await browserTabManager.queryAllTabs();
      setBrowserTabs(tabs);
      const warnings = browserTabManager.consumeWarnings();
      if (warnings.length > 0) {
        await showFailureToast(new Error(warnings.join("; ")), { title: "Some Browser Tabs Could Not Be Loaded" });
      }
      console.log(`Loaded ${tabs.length} browser tabs`);
    } catch (error) {
      tabsLoadedRef.current = false;
      console.error("Error loading browser tabs:", error);
      await showFailureToast(error, { title: "Browser Tab Refresh Failed" });
    } finally {
      endTabLoading();
    }
  }, [beginTabLoading, endTabLoading]);

  // Cache hydration is completed before live queries begin, so stale reads can
  // never overwrite fresher results that have already reached the UI.
  useEffect(() => {
    let isMounted = true;

    void (async () => {
      console.log("Extension mounted, hydrating caches before live refresh");
      try {
        const [cachedWindowsRaw, cachedTabs] = await Promise.all([
          LocalStorage.getItem<string>("cachedWindows"),
          browserTabManager.loadCachedTabs(),
        ]);
        if (!isMounted) return;
        if (cachedWindowsRaw) {
          const cachedWindows = parseCachedWindows(cachedWindowsRaw, Date.now(), CACHED_WINDOWS_MAX_AGE_MS);
          if (cachedWindows !== null) setWindows(cachedWindows as YabaiWindow[]);
        }
        if (cachedTabs !== null) setBrowserTabs(cachedTabs);
      } catch (error) {
        console.error("Failed to hydrate cached data:", error);
      }

      if (!isMounted) return;
      beginTabLoading();
      tabsLoadedRef.current = true;
      const tabRefresh = browserTabManager
        .queryAllTabs(true)
        .then((tabs) => {
          if (!isMounted) return;
          setBrowserTabs(tabs);
          const warnings = browserTabManager.consumeWarnings();
          if (warnings.length > 0) {
            void showFailureToast(new Error(warnings.join("; ")), { title: "Some Browser Tabs Could Not Be Loaded" });
          }
        })
        .catch(async (error) => {
          tabsLoadedRef.current = false;
          if (isMounted) await showFailureToast(error, { title: "Browser Tab Refresh Failed" });
        })
        .finally(() => {
          if (isMounted) endTabLoading();
        });

      await Promise.allSettled([refreshAllData(true), tabRefresh]);
    })();

    return () => {
      isMounted = false;
    };
  }, [beginTabLoading, endTabLoading, refreshAllData]);

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

  // Filter browser tabs based on search text (Spotlight-like behavior).
  // @ prefix OR "Browser Tabs" scope = show ONLY tabs; otherwise included with windows/apps.
  const filteredTabs = useMemo(() => {
    if (!Array.isArray(browserTabs) || browserTabs.length === 0) return [];

    // Determine the effective search text (effectiveTabFilter already handles @ and scope)
    const effectiveSearch = effectiveTabFilter.hasTabFilter ? effectiveTabFilter.remainingSearchText : searchText;

    // If tab-only mode with no search, show all tabs
    if (effectiveTabFilter.hasTabFilter && !effectiveSearch.trim()) return browserTabs;
    if (!effectiveSearch.trim()) return [];

    // Skip tabs if display filter is active (tabs don't have displays)
    if (displayFilter.hasDisplayFilter && !effectiveTabFilter.hasTabFilter) return [];

    return searchItems({
      items: browserTabs,
      query: effectiveSearch,
      fields: TAB_SEARCH_FIELDS,
      fuse: tabFuse,
    });
  }, [
    browserTabs,
    displayFilter.hasDisplayFilter,
    effectiveTabFilter.hasTabFilter,
    effectiveTabFilter.remainingSearchText,
    searchText,
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
        const cacheKey = `display-${displayFilter.displayNumber}-${getWindowSetKey(windowsToSearch)}`;
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

  const sortedWindows = useMemo(() => {
    const hasWindowSearchQuery = displayFilter.hasDisplayFilter
      ? displayFilter.remainingSearchText.trim().length > 0
      : searchText.trim().length > 0;
    if (hasWindowSearchQuery) return [...filteredWindows];

    const sorted = sortWindowsByMethod(filteredWindows, sortMethod, usageTimes, mergedFocusTimes);
    if (sortMethod === SortMethod.RECENTLY_USED && sorted.length > 1) {
      const previous = resolveFocusReference(focusHistory.previous, sorted);
      const previousIndex = previous ? sorted.findIndex((window) => window.id === previous.id) : -1;
      if (previousIndex > 1) {
        sorted.splice(1, 0, sorted.splice(previousIndex, 1)[0]);
      }
    }
    return sorted;
  }, [
    displayFilter.hasDisplayFilter,
    displayFilter.remainingSearchText,
    filteredWindows,
    focusHistory.previous,
    mergedFocusTimes,
    searchText,
    sortMethod,
    usageTimes,
  ]);
  const sortedWindowsRef = useRef(sortedWindows);
  useEffect(() => {
    sortedWindowsRef.current = sortedWindows;
    const orderedIds = sortedWindows.map((window) => getWindowItemId(window.id));
    const origin = getCycleOriginForSelection(selectedItemIdRef.current, orderedIds, cycleIndexRef.current);
    if (origin !== cycleIndexRef.current) {
      cycleIndexRef.current = origin;
      setCycleIndex(origin);
    }
  }, [sortedWindows]);

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
    const nextIndex = getCycledIndex(cycleIndexRef.current, sortedWindows.length, "next");
    cycleIndexRef.current = nextIndex;
    setCycleIndex(nextIndex);
    const nextItemId = getWindowItemId(sortedWindows[nextIndex].id);
    selectedItemIdRef.current = nextItemId;
    setUserSelectedItemId(nextItemId);
  }, [sortedWindows]);

  const cyclePrev = useCallback(() => {
    if (sortedWindows.length === 0) return;
    totalTabPressesRef.current += 1;
    const nextIndex = getCycledIndex(cycleIndexRef.current, sortedWindows.length, "previous");
    cycleIndexRef.current = nextIndex;
    setCycleIndex(nextIndex);
    const nextItemId = getWindowItemId(sortedWindows[nextIndex].id);
    selectedItemIdRef.current = nextItemId;
    setUserSelectedItemId(nextItemId);
  }, [sortedWindows]);

  // Cancel auto-select permanently when the user types anything
  useEffect(() => {
    if (inputText.length > 0 && !autoSelectCancelledRef.current) {
      autoSelectCancelledRef.current = true;
      // Also reset cycle index since the user is now searching
      cycleIndexRef.current = 0;
      setCycleIndex(0);
    }
  }, [inputText]);

  const usageTimesRef = useRef(usageTimes);
  useEffect(() => {
    usageTimesRef.current = usageTimes;
  }, [usageTimes]);

  const persistSuccessfulFocus = useCallback(
    async (window: YabaiWindow) => {
      const nextFocusState = advanceFocusState(
        { current: focusHistoryCurrentRef.current, previous: focusHistory.previous },
        makeFocusReference(window),
      );
      const nextUsage = recordWindowUsage(usageTimesRef.current, window, Date.now());
      focusHistoryCurrentRef.current = nextFocusState.current;
      usageTimesRef.current = nextUsage;
      setFocusHistory(nextFocusState);
      setUsageTimes(nextUsage);
      await Promise.all([
        runBestEffort(
          () =>
            enqueueStorageWrite(async () => {
              await LocalStorage.setItem("focusHistory", serializeFocusState(nextFocusState));
              await LocalStorage.setItem("usageTimes", serializeUsageStorage(nextUsage));
            }),
          (error) => console.warn("Could not persist focused-window state:", error),
        ),
        runBestEffort(
          () => focusHistoryManager.recordFocus(window),
          (error) => console.warn("Could not append focus history:", error),
        ),
      ]);
    },
    [enqueueStorageWrite, focusHistory.previous],
  );

  // Auto-select countdown — only activates after the first Tab press (cycleIndex >= 1).
  // Restart the same short pause after each press.
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
    const delay = AUTO_SELECT_DELAY_MS;
    const capturedTarget = makeFocusReference(altTabSelectedWindow);

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
      const win = resolveCountdownTarget(capturedTarget, selectedItemIdRef.current, sortedWindowsRef.current);
      if (!win || autoSelectCancelledRef.current) {
        setAutoSelectCountdown(null);
        return;
      }

      console.log(`Auto-select countdown fired, switching to ${win.app} (${win.id})`);

      const focusAction = handleFocusWindow(
        win.id,
        win.app,
        async () => {
          await persistSuccessfulFocus(win);
          await closeMainWindow();
        },
        applications,
        win.title,
      );
      await focusAction();

      setAutoSelectCountdown(null);
    }, delay);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      setAutoSelectCountdown(null);
    };
  }, [applications, cycleIndex, isFocusHistoryLoaded, isMergedFocusTimesReady, persistSuccessfulFocus]);

  const searchWebQuery = tabFilter.remainingSearchText.trim();
  const hasVisibleWindows =
    !effectiveTabFilter.hasTabFilter &&
    scopeFilter !== "applications" &&
    scopeFilter !== "tabs" &&
    sortedWindows.length > 0;
  const hasVisibleApplications =
    !effectiveTabFilter.hasTabFilter &&
    scopeFilter !== "windows" &&
    scopeFilter !== "tabs" &&
    filteredApplications.length > 0;
  const hasVisibleTabs = scopeFilter !== "windows" && scopeFilter !== "applications" && filteredTabs.length > 0;
  const shouldShowSearchWebResult =
    !calcMode.isCalcMode &&
    !(isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded) &&
    !hasVisibleWindows &&
    !hasVisibleApplications &&
    !hasVisibleTabs &&
    shouldShowWebFallbackForScope(scopeFilter, effectiveTabFilter.hasTabFilter, displayFilter.hasDisplayFilter) &&
    searchWebQuery.length > 0;

  const visibleItemIds = useMemo(() => {
    if (calcMode.isCalcMode) {
      return [CALC_RESULT_ITEM_ID];
    }

    const itemIds: string[] = [];

    if (!effectiveTabFilter.hasTabFilter && scopeFilter !== "tabs") {
      if (scopeFilter !== "applications") {
        itemIds.push(...sortedWindows.map((window) => getWindowItemId(window.id)));
      }
      if (scopeFilter !== "windows") {
        itemIds.push(...filteredApplications.map((application) => getApplicationItemId(application)));
      }
    }

    if (scopeFilter !== "windows" && scopeFilter !== "applications") {
      itemIds.push(...filteredTabs.map((tab) => getTabItemId(tab.id)));
    }

    if (shouldShowSearchWebResult) {
      itemIds.push(SEARCH_WEB_ITEM_ID);
    }

    return itemIds;
  }, [
    calcMode.isCalcMode,
    effectiveTabFilter.hasTabFilter,
    filteredApplications,
    filteredTabs,
    scopeFilter,
    shouldShowSearchWebResult,
    sortedWindows,
  ]);

  const selectedItemId = useMemo(() => {
    const defaultId = getDefaultSelectedItemId({
      hasSearchText: hasActiveSearch,
      emptySearchItemId: altTabSelectedWindow ? getWindowItemId(altTabSelectedWindow.id) : undefined,
      visibleItemIds,
    });
    return resolveVisibleSelection(userSelectedItemId, visibleItemIds, defaultId);
  }, [altTabSelectedWindow, hasActiveSearch, userSelectedItemId, visibleItemIds]);

  useEffect(() => {
    selectedItemIdRef.current = selectedItemId;
  }, [selectedItemId]);

  const handleSelectionChange = useCallback((itemId: string | null) => {
    const previousSelection = selectedItemIdRef.current;
    selectedItemIdRef.current = itemId ?? undefined;
    setUserSelectedItemId(itemId ?? undefined);
    const orderedIds = sortedWindowsRef.current.map((window) => getWindowItemId(window.id));
    const origin = getCycleOriginForSelection(itemId ?? undefined, orderedIds, cycleIndexRef.current);
    cycleIndexRef.current = origin;
    setCycleIndex(origin);
    if (totalTabPressesRef.current > 0 && itemId !== previousSelection) {
      autoSelectCancelledRef.current = true;
      setAutoSelectCountdown(null);
    }
  }, []);

  // No need for focus/blur detection anymore since we only refresh on mount

  // Get available display numbers for filtering actions
  const availableDisplays = useMemo(() => getAvailableDisplayNumbers(windows), [windows]);

  return (
    <List
      isLoading={
        !calcMode.isCalcMode &&
        (isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded)
      }
      isShowingDetail={isShowingDetail}
      onSearchTextChange={setInputText}
      searchBarPlaceholder="Search windows, apps, tabs… (@ tabs, #N display, = calc)"
      searchBarAccessory={<ScopeDropdown scopeFilter={scopeFilter} onScopeChange={setScopeFilter} />}
      filtering={false} // Disable built-in filtering since we're using Fuse.js
      throttle={false} // Disable throttling for more responsive search
      selectedItemId={selectedItemId}
      onSelectionChange={handleSelectionChange}
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
              void loadBrowserTabs();
            }}
            shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
          />
          <Action
            title={isShowingDetail ? "Hide Detail Panel" : "Show Detail Panel"}
            icon={Icon.Eye}
            onAction={() => setIsShowingDetail(!isShowingDetail)}
            shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
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
      {calcMode.isCalcMode && (
        <List.Item
          id={CALC_RESULT_ITEM_ID}
          key={CALC_RESULT_ITEM_ID}
          icon={Icon.Calculator}
          title={
            !calcMode.expression
              ? "Type a math expression…"
              : calcResult?.error
                ? `Error: ${calcResult.error}`
                : `= ${calcResult?.formatted ?? ""}`
          }
          subtitle={calcMode.expression || undefined}
          actions={
            <ActionPanel>
              {calcResult?.result !== null && calcResult?.formatted && (
                <Action.CopyToClipboard title="Copy Result" content={calcResult.formatted} />
              )}
              <Action
                title="Clear"
                onAction={() => setInputText("")}
                shortcut={{ modifiers: ["cmd"], key: "backspace" }}
              />
            </ActionPanel>
          }
        />
      )}

      {!calcMode.isCalcMode &&
        sortedWindows.length > 0 &&
        !effectiveTabFilter.hasTabFilter &&
        scopeFilter !== "applications" &&
        scopeFilter !== "tabs" && (
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
                detail={
                  isShowingDetail ? <WindowDetailPanel win={win} mergedFocusTimes={mergedFocusTimes} /> : undefined
                }
                actions={
                  <WindowActions
                    windowId={win.id}
                    windowApp={win.app}
                    windowTitle={win.title}
                    windowDisplay={win.display}
                    isFocused={win["has-focus"] || win.focused}
                    onFocused={async () => {
                      await persistSuccessfulFocus(win);
                      await closeMainWindow();
                    }}
                    setSortMethod={setSortMethod}
                    onRefresh={refreshAllData}
                    isRefreshing={isRefreshing}
                    applications={applications}
                    setInputText={setInputText}
                    windows={windows}
                    onCycleNext={cycleNext}
                    onCyclePrev={cyclePrev}
                    onToggleDetail={() => setIsShowingDetail(!isShowingDetail)}
                  />
                }
              />
            ))}
          </List.Section>
        )}

      {!calcMode.isCalcMode &&
        filteredApplications.length > 0 &&
        !effectiveTabFilter.hasTabFilter &&
        scopeFilter !== "windows" &&
        scopeFilter !== "tabs" && (
          <List.Section title="Applications" subtitle={filteredApplications.length.toString()}>
            {filteredApplications.map((app) => (
              <List.Item
                key={app.path}
                id={getApplicationItemId(app)}
                icon={{ fileIcon: app.path }}
                title={app.name}
                detail={isShowingDetail ? <AppDetailPanel app={app} /> : undefined}
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

      {!calcMode.isCalcMode &&
        filteredTabs.length > 0 &&
        scopeFilter !== "windows" &&
        scopeFilter !== "applications" && (
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
                detail={isShowingDetail ? <BrowserTabDetailPanel tab={tab} /> : undefined}
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
                    {canCloseBrowserTab(tab.browser) && (
                      <Action
                        title="Close Tab"
                        onAction={handleCloseBrowserTab(tab, () => {
                          setBrowserTabs((prev) => prev.filter((t) => t.id !== tab.id));
                        })}
                        shortcut={{ modifiers: ["cmd", "ctrl"], key: "w" }}
                      />
                    )}
                    <Action
                      title="Refresh Tabs"
                      onAction={() => {
                        tabsLoadedRef.current = false;
                        browserTabManager.invalidateCache();
                        void loadBrowserTabs();
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

      {!calcMode.isCalcMode && shouldShowSearchWebResult && (
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

      {!calcMode.isCalcMode &&
        !(isSearching || isRefreshing || isLoadingTabs || !isMergedFocusTimesReady || !isFocusHistoryLoaded) &&
        !shouldShowSearchWebResult &&
        !hasVisibleWindows &&
        !hasVisibleApplications &&
        !hasVisibleTabs && (
          <List.EmptyView
            title={effectiveTabFilter.hasTabFilter ? "No Browser Tabs Found" : "No Windows or Applications Found"}
            description={
              effectiveTabFilter.hasTabFilter
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
  windowDisplay,
  onFocused,

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
  onToggleDetail,
}: {
  windowId: number;
  windowApp: string;
  windowTitle: string;
  windowDisplay?: number;
  onFocused: (id: number) => void | Promise<void>;

  setSortMethod: (method: SortMethod) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  isFocused?: boolean;
  applications?: Application[];
  setInputText: (text: string) => void;
  windows: YabaiWindow[];
  onCycleNext: () => void;
  onCyclePrev: () => void;
  onToggleDetail: () => void;
}) {
  const availableDisplays = useMemo(() => getAvailableDisplayNumbers(windows), [windows]);
  return (
    <ActionPanel>
      <Action
        title="Switch to Window"
        onAction={handleFocusWindow(windowId, windowApp, onFocused, applications, windowTitle)}
      />
      <Action
        title="Open in New Space"
        onAction={handleOpenWindowInNewSpace(windowId, windowApp, windowTitle)}
        shortcut={{ modifiers: ["opt"], key: "enter" }}
      />

      <Action
        title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
        onAction={onRefresh}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
      />
      <ActionPanel.Section title="Display Actions">
        <MoveToFocusedDisplayAction windowId={windowId} windowApp={windowApp} windowTitle={windowTitle} />
        <InteractiveMoveToDisplayAction
          windowId={windowId}
          windowApp={windowApp}
          windowTitle={windowTitle}
          currentDisplay={windowDisplay}
        />

        <MoveWindowToDisplayActions
          windowId={windowId}
          windowApp={windowApp}
          windowTitle={windowTitle}
          currentDisplay={windowDisplay}
        />
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
      <ActionPanel.Section title="View">
        <Action
          title="Toggle Detail Panel"
          icon={Icon.Eye}
          onAction={onToggleDetail}
          shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
        />
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

// ---- Detail panel components ----

function WindowDetailPanel({ win, mergedFocusTimes }: { win: YabaiWindow; mergedFocusTimes: Record<number, number> }) {
  const lastFocusMs = mergedFocusTimes[win.id] ?? 0;
  const lastFocusStr = lastFocusMs > 0 ? new Date(lastFocusMs).toLocaleString() : "Not recorded";
  const frameStr = win.frame
    ? `${Math.round(win.frame.w)} × ${Math.round(win.frame.h)} at (${Math.round(win.frame.x)}, ${Math.round(win.frame.y)})`
    : undefined;

  return (
    <List.Item.Detail
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="App" text={win.app} />
          <List.Item.Detail.Metadata.Label title="Title" text={win.title || "(no title)"} />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label title="Display" text={String(win.display ?? "?")} />
          <List.Item.Detail.Metadata.Label title="Space" text={String(win.space ?? "?")} />
          {frameStr && <List.Item.Detail.Metadata.Label title="Frame" text={frameStr} />}
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.TagList title="State">
            {win["has-focus"] || win.focused ? (
              <List.Item.Detail.Metadata.TagList.Item text="Focused" color="#fbbf24" />
            ) : null}
            {win["is-native-fullscreen"] ? (
              <List.Item.Detail.Metadata.TagList.Item text="Fullscreen" color="#60a5fa" />
            ) : null}
            {!win["has-focus"] && !win.focused ? (
              <List.Item.Detail.Metadata.TagList.Item text="Background" color="#6b7280" />
            ) : null}
          </List.Item.Detail.Metadata.TagList>
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label title="Window ID" text={String(win.id)} />
          <List.Item.Detail.Metadata.Label title="PID" text={String(win.pid)} />
          <List.Item.Detail.Metadata.Label title="Last Focused" text={lastFocusStr} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function BrowserTabDetailPanel({ tab }: { tab: BrowserTab }) {
  return (
    <List.Item.Detail
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Title" text={tab.title || "Untitled"} />
          <List.Item.Detail.Metadata.Label title="Domain" text={tab.domain || "—"} />
          <List.Item.Detail.Metadata.Label title="URL" text={tab.url || "—"} />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label title="Browser" text={tab.browser} />
          <List.Item.Detail.Metadata.Label title="Window" text={String(tab.windowIndex)} />
          <List.Item.Detail.Metadata.Label title="Tab" text={String(tab.tabIndex)} />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.TagList title="State">
            {tab.isActive ? (
              <List.Item.Detail.Metadata.TagList.Item text="Active" color="#10b981" />
            ) : (
              <List.Item.Detail.Metadata.TagList.Item text="Background" color="#6b7280" />
            )}
          </List.Item.Detail.Metadata.TagList>
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function AppDetailPanel({ app }: { app: Application }) {
  return (
    <List.Item.Detail
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Name" text={app.name} />
          <List.Item.Detail.Metadata.Label title="Path" text={app.path || "Unknown"} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

// ---- Scope filter dropdown ----

function ScopeDropdown({
  scopeFilter,
  onScopeChange,
}: {
  scopeFilter: "all" | "windows" | "applications" | "tabs";
  onScopeChange: (value: "all" | "windows" | "applications" | "tabs") => void;
}) {
  return (
    <List.Dropdown
      tooltip="Filter by type"
      value={scopeFilter}
      onChange={(v) => onScopeChange(v as "all" | "windows" | "applications" | "tabs")}
    >
      <List.Dropdown.Item title="All" value="all" />
      <List.Dropdown.Section title="Type">
        <List.Dropdown.Item title="Windows" value="windows" icon={Icon.Window} />
        <List.Dropdown.Item title="Applications" value="applications" icon={Icon.Desktop} />
        <List.Dropdown.Item title="Browser Tabs" value="tabs" icon={Icon.Globe} />
      </List.Dropdown.Section>
    </List.Dropdown>
  );
}
