// TypeScript
import { Action, ActionPanel, closeMainWindow, LaunchType, List, LocalStorage } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Application, ENV, SortMethod, YABAI, YabaiWindow } from "./models";
import { handleAggregateToSpace, handleCloseEmptySpaces, handleCloseWindow, handleFocusWindow } from "./handlers";
import { DisperseOnDisplayActions, MoveToDisplaySpace, MoveWindowToDisplayActions } from "./display-actions-yabai";
import Fuse from "fuse.js";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";

// Performance optimization imports
import { performanceMonitor } from "./utils/performanceMonitor";
import { storageManager } from "./utils/batchedStorage";
import { asyncApplicationLoader } from "./utils/asyncApplicationLoader";
import { createOptimizedSearch } from "./utils/optimizedSearch";

// Function to list applications from standard directories
function listApplications(): Application[] {
  const applications: Application[] = [];
  const appDirectories = [
    "/Applications",
    path.join(ENV.HOME, "Applications"),
    "/System/Applications",
    "/System/Library/CoreServices",
  ];

  for (const dir of appDirectories) {
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".app")) {
            const appPath = path.join(dir, file);
            const appName = file.replace(".app", "");
            applications.push({ name: appName, path: appPath });
          }
        }
      } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
      }
    }
  }

  return applications;
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

export default function Command(props: { launchContext?: { launchType: LaunchType } }) {
  const [usageTimes, setUsageTimes] = useState<Record<string, number>>({});
  const [inputText, setInputText] = useState("");
  const searchText = useDebounce(inputText, 30); // Reduced debounce delay for better responsiveness
  const [windows, setWindows] = useState<YabaiWindow[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [sortMethod, setSortMethod] = useState<SortMethod>(SortMethod.RECENTLY_USED);
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);

  // Focus history to track current and previous focused windows
  const [focusHistory, setFocusHistory] = useState<{
    current: number | null;
    previous: number | null;
  }>({ current: null, previous: null });

  // Function to remove a window from the local listing after it's closed.
  const removeWindow = useCallback((id: number) => {
    setWindows((prevWindows) => prevWindows.filter((w) => w.id !== id));
  }, []);

  const updateFocusHistory = useCallback((windowsData: YabaiWindow[]) => {
    const currentlyFocused = windowsData.find((win) => win["has-focus"] === true);
    const currentFocusedId = currentlyFocused?.id || null;

    setFocusHistory((prevHistory) => {
      if (currentFocusedId !== prevHistory.current) {
        return {
          current: currentFocusedId,
          previous: prevHistory.current,
        };
      }
      return prevHistory;
    });
  }, []);

  const refreshApplications = useCallback(async () => {
    return performanceMonitor.measureAsync('app-refresh', async () => {
      try {
        // Use async loader instead of sync listApplications
        const freshApps = await asyncApplicationLoader.loadApplications(true);
        setApplications(freshApps);
        console.log("Updated applications cache");
      } catch (error) {
        console.error("Error refreshing applications:", error);
      }
    });
  }, []);

  // Function to refresh windows data
  const refreshWindows = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const { stdout } = await exec(`${YABAI} -m query --windows`, { env: ENV });
      if (stdout) {
        // Ensure stdout is a string before parsing
        const stdoutStr = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
        try {
          const parsed = JSON.parse(stdoutStr);
          const windowsData = Array.isArray(parsed) ? parsed : [];
          setWindows(windowsData);
          updateFocusHistory(windowsData);

          // Update cache with timestamp
          const cacheData = {
            windows: windowsData,
            timestamp: Date.now(),
          };
          await LocalStorage.setItem("cachedWindows", JSON.stringify(cacheData));
          setLastRefreshTime(Date.now());
          console.log("Updated windows cache");
        } catch (parseError) {
          console.error("Error parsing windows data:", parseError, "Raw data:", stdoutStr);
        }
      }
    } catch (error) {
      console.error("Error refreshing windows:", error);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Function to refresh all data
  const refreshAllData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([refreshWindows(), refreshApplications()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshWindows, refreshApplications]);

  // Load previous usage times, sort method, and focus history from optimized storage when the component mounts.
  useEffect(() => {
    performanceMonitor.startTimer('initial-load');
    
    (async () => {
      try {
        // Load data using optimized storage manager
        const [storedTimes, storedSortMethod, storedFocusHistory] = await Promise.all([
          storageManager.get<Record<string, number>>("usageTimes"),
          storageManager.get<SortMethod>("sortMethod"),
          storageManager.get<{ current: number | null; previous: number | null }>("focusHistory")
        ]);

        if (storedTimes) {
          setUsageTimes(storedTimes);
        }

        if (storedSortMethod) {
          setSortMethod(storedSortMethod);
        } else {
          setSortMethod(SortMethod.RECENTLY_USED);
        }

        if (storedFocusHistory) {
          setFocusHistory(storedFocusHistory);
        }
      } catch (error) {
        console.error("Error loading initial data:", error);
      }
      
      performanceMonitor.endTimer('initial-load');
    })();
  }, []);

  // Persist usage times in local storage when they change (batched).
  useEffect(() => {
    storageManager.set("usageTimes", usageTimes);
  }, [usageTimes]);

  // Persist sort method in local storage when it changes (batched).
  useEffect(() => {
    storageManager.set("sortMethod", sortMethod);
  }, [sortMethod]);

  // Persist focus history in local storage when it changes (batched).
  useEffect(() => {
    storageManager.set("focusHistory", focusHistory);
  }, [focusHistory]);

  // Query windows using useExec.
  const { isLoading, data, error } = useExec<YabaiWindow[]>(YABAI, ["-m", "query", "--windows"], {
    env: ENV,
    parseOutput: ({ stdout }) => {
      if (!stdout) return [];
      try {
        // Ensure stdout is a string before parsing
        const stdoutStr = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
        const parsed = JSON.parse(stdoutStr);
        return Array.isArray(parsed) ? parsed : [];
      } catch (parseError) {
        console.error("Error parsing windows data in useExec:", parseError);
        return [];
      }
    },
    keepPreviousData: false,
  });

  // Load cached windows and handle data changes
  useEffect(() => {
    // Load cached windows on mount
    const loadCachedWindows = async () => {
      const cachedData = await LocalStorage.getItem<string>("cachedWindows");
      if (cachedData) {
        try {
          const { windows: cachedWindows, timestamp } = JSON.parse(cachedData);
          if (Array.isArray(cachedWindows) && cachedWindows.length > 0) {
            setWindows(cachedWindows);
            updateFocusHistory(cachedWindows);
            setLastRefreshTime(timestamp);
            console.log("Loaded windows from cache, timestamp:", new Date(timestamp).toLocaleString());
          }
        } catch (error) {
          console.error("Error parsing cached windows:", error);
        }
      }
    };

    loadCachedWindows();

    // Handle data changes from useExec
    if (data !== undefined) {
      setWindows(data);
      updateFocusHistory(data);

      // Update cache with timestamp
      const cacheData = {
        windows: data,
        timestamp: Date.now(),
      };
      LocalStorage.setItem("cachedWindows", JSON.stringify(cacheData));
      setLastRefreshTime(Date.now());
      console.log("Updated windows cache from useExec");
    } else if (!isLoading && !error && !data) {
      setWindows([]);
      updateFocusHistory([]);
    }
  }, [data, isLoading, error]);

  // Handle background refresh and launch type
  useEffect(() => {
    // Check if we need to refresh based on launch type
    if (props.launchContext?.launchType === LaunchType.UserInitiated) {
      // User explicitly launched the extension, refresh data
      console.log("User initiated launch, refreshing data");
      refreshAllData();
    }

    // Check if data is stale (older than 5 minutes)
    const isDataStale = Date.now() - lastRefreshTime > 5 * 60 * 1000;
    if (isDataStale && lastRefreshTime > 0) {
      console.log("Data is stale, refreshing");
      refreshAllData();
    }

    // Set up periodic refresh (every 5 minutes)
    const refreshInterval = setInterval(
      () => {
        console.log("Periodic refresh");
        refreshAllData();
      },
      5 * 60 * 1000,
    );

    return () => {
      clearInterval(refreshInterval);
    };
  }, [props.launchContext, lastRefreshTime, refreshAllData]);

  // Load applications when the component mounts using async loader
  useEffect(() => {
    const loadApplications = async () => {
      try {
        // Use the async application loader with caching
        const apps = await asyncApplicationLoader.loadApplications();
        setApplications(apps);
      } catch (error) {
        console.error("Error loading applications with async loader:", error);
        // Fallback to refreshApplications if async loader fails
        await refreshApplications();
      }
    };

    loadApplications();
  }, [refreshApplications]);

  // Create a Fuse instance for fuzzy searching windows
  const fuse = useMemo(() => {
    if (!Array.isArray(windows) || windows.length === 0) return null;
    return new Fuse(windows, {
      keys: [
        { name: "title", weight: 2 }, // Give title higher weight
        { name: "app", weight: 1 },
      ],
      includeScore: true,
      threshold: 0.4, // Lower threshold for stricter matching
      ignoreLocation: true, // Search the entire string, not just from the beginning
      useExtendedSearch: true, // Enable extended search for more powerful queries
      sortFn: (a, b) => {
        // Custom sort function to prioritize exact matches
        if (a.score === b.score) {
          // If scores are equal, prioritize shorter matches (more precise)
          return a.item.title.toString().length - b.item.title.toString().length;
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
          return a.item.name.toString().length - b.item.name.toString().length;
        }
        return a.score - b.score; // Lower score is better
      },
    });
  }, [applications]);

  // Set searching state when input text changes
  useEffect(() => {
    if (inputText.trim() && inputText !== searchText) {
      setIsSearching(true);
    } else {
      setIsSearching(false);
    }
  }, [inputText, searchText]);

  // Filter windows based on the search text using fuzzy search
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    if (!searchText.trim()) return windows; // Return all windows if search text is empty

    if (!fuse) return [];

    // Use Fuse.js for fuzzy searching
    try {
      // First try exact match on app name or title
      const exactMatches = windows.filter(
        (win) =>
          win.app.toLowerCase().includes(searchText.toLowerCase()) ||
          win.title.toLowerCase().includes(searchText.toLowerCase()),
      );

      // If we have exact matches, prioritize them
      if (exactMatches.length > 0) {
        setIsSearching(false);
        return exactMatches;
      }

      // Otherwise use fuzzy search
      const results = fuse.search(searchText);
      setIsSearching(false); // Search is complete
      return results.map((result) => result.item);
    } catch (error) {
      console.error("Error during search:", error);
      setIsSearching(false);
      return windows; // Fallback to all windows on error
    }
  }, [windows, searchText, fuse]);

  // Filter applications based on the search text using fuzzy search
  const filteredApplications = useMemo(() => {
    if (!Array.isArray(applications)) return [];
    if (!searchText.trim()) return applications; // Return all applications if search text is empty

    if (!appFuse) return [];

    // Use fuzzy search with optimizations
    try {
      // First try exact match on app name
      const exactMatches = applications.filter((app) => app.name.toLowerCase().includes(searchText.toLowerCase()));

      // If we have exact matches, prioritize them
      if (exactMatches.length > 0) {
        setIsSearching(false);
        return exactMatches;
      }

      // Otherwise use fuzzy search
      const results = appFuse.search(searchText);
      setIsSearching(false); // Search is complete
      return results.map((result) => result.item);
    } catch (error) {
      console.error("Error during application search:", error);
      setIsSearching(false);
      return applications; // Fallback to all applications on error
    }
  }, [applications, searchText, appFuse]);

  // Sort windows based on selected sort method.
  const sortedWindows = useMemo(() => {
    const windows = [...filteredWindows];

    if (sortMethod === SortMethod.USAGE) {
      // Sort by usage (clicks)
      return windows.sort((a, b) => {
        const timeA = usageTimes[a.id] || 0;
        const timeB = usageTimes[b.id] || 0;
        return timeB - timeA;
      });
    } else if (sortMethod === SortMethod.RECENTLY_USED) {
      // Sort by recently used using usage times instead of focus history
      // Get the two most recently used windows (by usage timestamp)
      const recentlyUsedIds = Object.entries(usageTimes)
        .sort(([, timeA], [, timeB]) => timeB - timeA)
        .slice(0, 2)
        .map(([id]) => parseInt(id));

      // Find the corresponding windows
      const previousWindow = recentlyUsedIds[1] ? windows.find((w) => w.id === recentlyUsedIds[1]) : null; // second most recent
      const currentWindow = recentlyUsedIds[0] ? windows.find((w) => w.id === recentlyUsedIds[0]) : null;  // most recent

      return windows.sort((a, b) => {
        // Previous window (second most recently used) comes first
        if (previousWindow && a.id === previousWindow.id) return -1;
        if (previousWindow && b.id === previousWindow.id) return 1;

        // Current window (most recently used) comes second
        if (currentWindow && a.id === currentWindow.id) return -1;
        if (currentWindow && b.id === currentWindow.id) return 1;

        // For the rest (third position onwards), sort by usage time (most recent first)
        const timeA = usageTimes[a.id] || 0;
        const timeB = usageTimes[b.id] || 0;
        return timeB - timeA;
      });
    }

    // Default fallback to usage sort
    return windows.sort((a, b) => {
      const timeA = usageTimes[a.id] || 0;
      const timeB = usageTimes[b.id] || 0;
      return timeB - timeA;
    });
  }, [filteredWindows, usageTimes, sortMethod, focusHistory]);

  // Always select the first window in the list
  const firstWindow = useMemo(() => {
    return sortedWindows.length > 0 ? sortedWindows[0] : undefined;
  }, [sortedWindows]);

  // Cleanup and performance summary on unmount
  useEffect(() => {
    return () => {
      // Flush any pending storage operations
      storageManager.flush().catch(err => 
        console.error('Error flushing storage on unmount:', err)
      );
      
      // Log performance summary in development
      if (process.env.NODE_ENV === 'development') {
        performanceMonitor.logSummary();
      }
    };
  }, []);

  return (
    <List
      isLoading={isLoading || isSearching || isRefreshing}
      onSearchTextChange={setInputText}
      searchBarPlaceholder="Search windows and applications..."
      filtering={false} // Disable built-in filtering since we're using Fuse.js
      throttle={false} // Disable throttling for more responsive search
      selectedItemId={firstWindow ? `window-${firstWindow.id}` : undefined} // Select first window by default (index 0)
      actions={
        <ActionPanel>
          <Action
            title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
            onAction={refreshAllData}
            shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
          />
        </ActionPanel>
      }
    >
      {sortedWindows.length > 0 && (
        <List.Section title="Windows" subtitle={sortedWindows.length.toString()}>
          {sortedWindows.map((win) => (
            <List.Item
              key={win.id}
              id={`window-${win.id}`} // Add id for default selection
              icon={getAppIcon(win, applications)}
              title={win.app}
              subtitle={win.title}
              accessories={win["has-focus"] || win.focused ? [{ text: "focused" }] : []}
              actions={
                <WindowActions
                  windowId={win.id}
                  windowApp={win.app}
                  isFocused={win["has-focus"] || win.focused}
                  onFocused={(id) => {
                    setUsageTimes((prev) => ({
                      ...prev,
                      [id]: Date.now(),
                    }));
                    closeMainWindow();
                  }}
                  onRemove={removeWindow}
                  setSortMethod={setSortMethod}
                  onRefresh={refreshAllData}
                  isRefreshing={isRefreshing}
                />
              }
            />
          ))}
        </List.Section>
      )}

      {filteredApplications.length > 0 && (
        <List.Section title="Applications" subtitle={filteredApplications.length.toString()}>
          {filteredApplications.map((app) => (
            <List.Item
              key={app.path}
              icon={{ fileIcon: app.path }}
              title={app.name}
              actions={
                <ActionPanel>
                  <Action
                    title="Open Application"
                    onAction={() => {
                      exec(`open "${app.path}"`);
                    }}
                    shortcut={{ modifiers: [], key: "enter" }}
                  />
                  <Action
                    title={isRefreshing ? "Refreshing…" : "Refresh Windows & Apps"}
                    onAction={refreshAllData}
                    shortcut={{ modifiers: ["cmd", "ctrl"], key: "r" }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {!isLoading && sortedWindows.length === 0 && filteredApplications.length === 0 && (
        <List.EmptyView title="No Windows or Applications Found" description="No windows or applications were found." />
      )}

      {error && (
        <List.EmptyView
          title="Error Fetching Windows"
          description={error.message}
          icon={{ source: "@raycast/api/exclamation-mark-triangle-fill" }}
        />
      )}
    </List>
  );
}

function WindowActions({
  windowId,
  windowApp,
  onFocused,
  onRemove,
  setSortMethod,
  onRefresh,
  isRefreshing,
  isFocused,
}: {
  windowId: number;
  windowApp: string;
  onFocused: (id: number) => void;
  onRemove: (id: number) => void;
  setSortMethod: (method: SortMethod) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  isFocused?: boolean;
}) {
  return (
    <ActionPanel>
      <Action
        title="Switch to Window"
        onAction={isFocused ? () => onFocused(windowId) : handleFocusWindow(windowId, windowApp, onFocused)}
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
        <DisperseOnDisplayActions />
        <MoveWindowToDisplayActions windowId={windowId} windowApp={windowApp} />
        <MoveToDisplaySpace windowId={windowId} windowApp={windowApp} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Sort by">
        <Action title="Sort by Previous" onAction={() => setSortMethod(SortMethod.RECENTLY_USED)} />
        <Action title="Sort by Usage" onAction={() => setSortMethod(SortMethod.USAGE)} />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function getAppIcon(window: YabaiWindow, applications: Application[]) {
  const appName = window.app;

  // 1. Try to find the application in the pre-loaded applications list
  const foundApp = applications.find((app) => app.name === appName);
  if (foundApp) {
    return { fileIcon: foundApp.path };
  }

  // 2. Handle special cases for system apps with known paths or built-in icons
  if (appName === "Finder") {
    return { fileIcon: "/System/Library/CoreServices/Finder.app" };
  }
  if (appName === "SystemUIServer" || appName === "Control Center") {
    return { source: "gear" }; // Raycast built-in icon
  }

  // 3. Handle common apps with specific Raycast built-in icons
  if (appName.toLowerCase().includes("chrome")) {
    return { source: "globe" };
  }
  if (appName.toLowerCase().includes("terminal") || appName.toLowerCase().includes("iterm")) {
    return { source: "terminal" };
  }
  if (appName.toLowerCase().includes("safari") || appName.toLowerCase().includes("firefox")) {
    return { source: "globe" };
  }
  if (appName.toLowerCase().includes("mail") || appName.toLowerCase().includes("outlook")) {
    return { source: "envelope" };
  }
  if (
    appName.toLowerCase().includes("slack") ||
    appName.toLowerCase().includes("whatsapp") ||
    appName.toLowerCase().includes("messages") ||
    appName.toLowerCase().includes("telegram")
  ) {
    return { source: "message" };
  }
  if (
    appName.toLowerCase().includes("notes") ||
    appName.toLowerCase().includes("text") ||
    appName.toLowerCase().includes("word") ||
    appName.toLowerCase().includes("pages")
  ) {
    return { source: "document" };
  }
  if (
    appName.toLowerCase().includes("code") ||
    appName.toLowerCase().includes("studio") ||
    appName.toLowerCase().includes("webstorm") ||
    appName.toLowerCase().includes("intellij") ||
    appName.toLowerCase().includes("pycharm")
  ) {
    return { source: "terminal" }; // Using terminal for IDEs, could be 'code' if available
  }

  // 4. Fallback to a generic application icon
  return { source: "app-generic" };
}
