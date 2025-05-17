// TypeScript
import { Action, ActionPanel, List, LocalStorage, showToast, Toast } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useState, useEffect, useMemo, useCallback } from "react";
import { promisify } from "node:util";
import { exec, execFile } from "node:child_process";

interface YabaiWindow {
  id: number;
  app: string;
  title: string;
  space: number;
}

interface YabaiSpace {
  index: number;
  windows: any[];
}

const execFilePromise = promisify(execFile);
const YABAI = "/opt/homebrew/bin/yabai";
const ENV = {
  USER: "rs",
  HOME: "/Users/rs",
};

export default function Command() {
  const [usageTimes, setUsageTimes] = useState<Record<string, number>>({});
  const [searchText, setSearchText] = useState("");
  const [windows, setWindows] = useState<YabaiWindow[]>([]);

  // Load previous usage times from local storage when the component mounts.
  useEffect(() => {
    (async () => {
      const storedTimes = await LocalStorage.getItem<string>("usageTimes");
      if (storedTimes) {
        try {
          setUsageTimes(JSON.parse(storedTimes));
        } catch {
          setUsageTimes({});
        }
      }
    })();
  }, []);

  // Persist usage times in local storage when they change.
  useEffect(() => {
    LocalStorage.setItem("usageTimes", JSON.stringify(usageTimes));
  }, [usageTimes]);

  // Query windows using useExec.
  const { isLoading, data, error } = useExec<YabaiWindow[]>(YABAI, ["-m", "query", "--windows"], {
    env: ENV,
    parseOutput: ({ stdout }) => {
      if (!stdout) return [];
      try {
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    initialData: [],
    keepPreviousData: false,
  });

  useEffect(() => {
    if (data !== undefined) {
      setWindows(data);
    } else if (!isLoading && !error) {
      setWindows([]);
    }
  }, [data, isLoading, error]);

  // Function to remove a window from the local listing after it's closed.
  const removeWindow = useCallback((id: number) => {
    setWindows((prevWindows) => prevWindows.filter((w) => w.id !== id));
  }, []);

  // Filter windows based on the search text.
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    const lowerQuery = searchText.toLowerCase();
    return windows.filter(
      (win) => win.title.toLowerCase().includes(lowerQuery) || win.app.toLowerCase().includes(lowerQuery),
    );
  }, [windows, searchText]);

  // Sort windows based on usage times.
  const sortedWindows = useMemo(() => {
    return [...filteredWindows].sort((a, b) => {
      const timeA = usageTimes[a.id] || 0;
      const timeB = usageTimes[b.id] || 0;
      return timeB - timeA;
    });
  }, [filteredWindows, usageTimes]);

  return (
    <List isLoading={isLoading} onSearchTextChange={setSearchText} searchBarPlaceholder="Search windows..." throttle>
      <List.Section title="Windows" subtitle={sortedWindows.length.toString()}>
        {sortedWindows.map((win) => (
          <List.Item
            key={win.id}
            icon={getAppIcon(win.app)}
            title={win.app}
            subtitle={win.title}
            actions={
              <WindowActions
                windowId={win.id}
                windowApp={win.app}
                onFocused={(id) =>
                  setUsageTimes((prev) => ({
                    ...prev,
                    [id]: Date.now(),
                  }))
                }
                onRemove={removeWindow}
              />
            }
          />
        ))}
      </List.Section>

      {!isLoading && sortedWindows.length === 0 && (
        <List.EmptyView
          title="No Windows Found"
          description="Yabai reported no windows, or there was an issue fetching them."
        />
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
}: {
  windowId: number;
  windowApp: string;
  onFocused: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  // Focus a window.
  const handleFocusWindow = async () => {
    await showToast({ style: Toast.Style.Animated, title: "Focusing Window..." });
    try {
      const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], {
        env: ENV,
      });
      if (stderr?.trim()) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error - Focus Window",
          message: stderr.trim(),
        });
      } else {
        onFocused(windowId);
        await showToast({
          style: Toast.Style.Success,
          title: "Window Focused",
          message: `Window ${windowApp} focused`,
        });
      }
    } catch (error: any) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Focus Window",
        message: error.message || "Unknown error while focusing window",
      });
    }
  };

  // Close a window and remove it from the list.
  const handleCloseWindow = async () => {
    await showToast({ style: Toast.Style.Animated, title: "Closing Window..." });
    try {
      const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--close"], {
        env: ENV,
      });
      if (stderr?.trim()) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error - Close Window",
          message: stderr.trim(),
        });
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: "Window Closed",
          message: `Window ${windowApp} closed`,
        });
        onRemove(windowId);
      }
    } catch (error: any) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Close Window",
        message: error.message || "Unknown error while closing window",
      });
    }
  };

  // Aggregate all windows with the same app name into an empty or newly created space.
  const handleAggregateToSpace = async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: "Aggregating Windows...",
    });
    try {
      // Step 1: Query the current window for its space.
      const currentWinResult = await execFilePromise(
        YABAI,
        ["-m", "query", "--windows", "--window", windowId.toString()],
        { env: ENV },
      );
      const currentWin: YabaiWindow = JSON.parse(currentWinResult.stdout);
      const currentSpace = currentWin.space;
      console.log("Current space:", currentSpace);

      // Step 2: Query all windows and count those in the current space.
      const allWinsResult = await execFilePromise(YABAI, ["-m", "query", "--windows"], { env: ENV });
      const allWindows: YabaiWindow[] = JSON.parse(allWinsResult.stdout);
      const windowsInCurrentSpace = allWindows.filter((w) => w.space === currentSpace);
      console.log("Windows in current space:", windowsInCurrentSpace.length);

      if (windowsInCurrentSpace.length < 2) {
        await showToast({
          style: Toast.Style.Normal,
          title: "Nothing to Aggregate",
          message: "The current space contains only one window.",
        });
        return;
      }

      // Step 3: Find an empty space.
      const spacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
      const spaces: YabaiSpace[] = JSON.parse(spacesResult.stdout);
      let targetSpace = spaces.find((s) => Array.isArray(s.windows) && s.windows.length === 0);

      // Step 4: Create a new space if no empty one is found.
      if (!targetSpace) {
        const createResult = await execFilePromise(YABAI, ["-m", "space", "--create"], { env: ENV });
        console.log("Space creation output:", createResult.stdout);
        const spacesResultAfter = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
        const updatedSpaces: YabaiSpace[] = JSON.parse(spacesResultAfter.stdout);
        targetSpace = updatedSpaces.find((s) => Array.isArray(s.windows) && s.windows.length === 0);
      }

      if (!targetSpace) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Aggregation Failed",
          message: "Could not find or create an empty space.",
        });
        return;
      }

      const targetSpaceId = targetSpace.index;
      console.log("Target space id:", targetSpaceId);

      // Step 5: Filter windows of the same app (case‑insensitive).
      const matchingWindows = allWindows.filter((w) => w.app.toLowerCase() === windowApp.toLowerCase());
      console.log(`Moving ${matchingWindows.length} windows for app '${windowApp}' to space ${targetSpaceId}.`);

      // Step 6: Move each matching window using the correct order of parameters.
      for (const win of matchingWindows) {
        try {
          const moveResult = await execFilePromise(
            YABAI,
            ["-m", "window", win.id.toString(), "--space", targetSpaceId.toString()],
            { env: ENV },
          );
          if (moveResult.stderr?.trim()) {
            console.error(`Error moving window ${win.id}: ${moveResult.stderr.trim()}`);
          } else {
            console.log(`Moved window ${win.id} to space ${targetSpaceId}.`);
          }
        } catch (innerError: any) {
          console.error(`Exception while moving window ${win.id}: ${innerError.message}`);
        }
      }

      // Step 7: Focus the target space.
      await execFilePromise(YABAI, ["-m", "space", "--focus", targetSpaceId.toString()], { env: ENV });

      // Step 8: Focus one of the moved windows (here, the first one in the matching list).
      if (matchingWindows.length > 0) {
        const focusWindowId = matchingWindows[0].id;
        await execFilePromise(YABAI, ["-m", "window", focusWindowId.toString(), "--focus"], { env: ENV });
      }

      await showToast({
        style: Toast.Style.Success,
        title: "Aggregation Complete",
        message: `All "${windowApp}" windows have been moved to space ${targetSpaceId} and one has been focused.`,
      });
    } catch (error: any) {
      console.error("Aggregation failed:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Aggregation Failed",
        message: error.message || "An unknown error occurred during aggregation.",
      });
    }
  };

  const execPromise = promisify(exec);
  async function handleCloseEmptySpaces() {
    await showToast({ style: Toast.Style.Animated, title: "Closing Empty Spaces..." });
    try {
      const command = `${YABAI} -m query --spaces | jq '.[] | select(.windows | length == 0) | .index' | xargs -I {} ${YABAI} -m space {} --destroy`;
      const { stdout, stderr } = await execPromise(command, { env: ENV });
      if (stderr?.trim()) {
        console.error(stderr);
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error - Close Empty Spaces",
          message: stderr.trim(),
        });
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: "Spaces Closed",
          message: "Empty spaces closed",
        });
        onRemove(windowId);
      }
    } catch (error: any) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Close Empty Spaces",
        message: error.message || "Unknown error while closing window",
      });
    }
  }


  return (
    <ActionPanel>
      <Action title="Switch to Window" onAction={handleFocusWindow} shortcut={{ modifiers: [], key: "enter" }} />
      <Action
        title="Aggregate to Space"
        onAction={handleAggregateToSpace}
        shortcut={{ modifiers: ["cmd", "opt"], key: "m" }}
      />
      <Action title="Close Window" onAction={handleCloseWindow} shortcut={{ modifiers: ["cmd", "opt"], key: "w" }} />
      <Action title="Close Empty Spaces" onAction={handleCloseEmptySpaces} shortcut={{ modifiers: ["cmd", "opt"], key: "q" }} />
    </ActionPanel>
  );
}

function getAppIcon(appName: string) {
  return { fileIcon: `/Applications/${appName}.app` };
}
