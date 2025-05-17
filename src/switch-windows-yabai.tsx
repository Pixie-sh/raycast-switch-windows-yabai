// Command.tsx
import {
  Action,
  ActionPanel,
  List,
  LocalStorage,
  showToast,
  Toast,
} from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useState, useEffect, useMemo, useCallback } from "react";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

interface YabaiWindow {
  id: number;
  app: string;
  title: string;
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

  // Load usageTimes from local storage on mount
  useEffect(() => {
    (async () => {
      const storedTimes = await LocalStorage.getItem<string>("usageTimes");
      if (storedTimes) {
        try {
          setUsageTimes(JSON.parse(storedTimes) as Record<string, number>);
        } catch {
          // Parsing error; start fresh.
        }
      }
    })();
  }, []);

  // Save usageTimes whenever they change
  useEffect(() => {
    LocalStorage.setItem("usageTimes", JSON.stringify(usageTimes));
  }, [usageTimes]);

  // useExec to initially get Yabai windows
  const { isLoading, data, error } = useExec<YabaiWindow[]>(
    YABAI,
    ["-m", "query", "--windows"],
    {
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
    }
  );

  // Update windows state when data is fetched.
  useEffect(() => {
    if (data !== undefined) {
      setWindows(data);
    } else if (!isLoading && !error) {
      setWindows([]);
    }
  }, [data, isLoading, error]);

  // Function to remove a window from the list after it's closed
  const removeWindow = useCallback((id: number) => {
    setWindows((prevWindows) => prevWindows.filter((w) => w.id !== id));
  }, []);

  // Filter windows based on search text
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    const lowerQuery = searchText.toLowerCase();
    return windows.filter(
      (win) =>
        win.title.toLowerCase().includes(lowerQuery) ||
        win.app.toLowerCase().includes(lowerQuery)
    );
  }, [windows, searchText]);

  // Sort windows according to usageTimes
  const sortedWindows = useMemo(() => {
    return [...filteredWindows].sort((a, b) => {
      const timeA = usageTimes[a.id] || 0;
      const timeB = usageTimes[b.id] || 0;
      return timeB - timeA;
    });
  }, [filteredWindows, usageTimes]);

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search windows..."
      throttle
    >
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
                onFocused={(id) => {
                  setUsageTimes((prev) => ({
                    ...prev,
                    [id]: Date.now(),
                  }));
                }}
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
  const handleFocusWindow = async () => {
    await showToast({ style: Toast.Style.Animated, title: "Focusing Window..." });
    try {
      const { stdout, stderr } = await execFilePromise(
        YABAI,
        ["-m", "window", "--focus", windowId.toString()],
        { env: ENV }
      );
      if (stderr) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error",
          message: stderr.trim(),
        });
      } else {
        console.log("Yabai output:", stdout);
        onFocused(windowId);
        await showToast({
          style: Toast.Style.Success,
          title: "Window Focused",
          message: `Window ${windowApp} (yabai id: ${windowId})`,
        });
      }
    } catch (error: any) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Focus Window",
        message: error.message || "Unknown error",
      });
    }
  };

  const handleCloseWindow = async () => {
    await showToast({ style: Toast.Style.Animated, title: "Closing Window..." });
    try {
      const { stdout, stderr } = await execFilePromise(
        YABAI,
        ["-m", "window", "--close", windowId.toString()],
        { env: ENV }
      );

      if (stderr) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error",
          message: stderr.trim(),
        });
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: "Window Closed",
          message: `Window ${windowApp} (yabai id: ${windowId}) closed`,
        });
        // Remove the closed window from the list
        onRemove(windowId);
      }
      console.log("Yabai output:", stdout);
    } catch (error: any) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Close Window",
        message: error.message || "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Switch to Window" onAction={handleFocusWindow} />
      <Action title="Close Window" onAction={handleCloseWindow} />
    </ActionPanel>
  );
}

function getAppIcon(appName: string) {
  return { fileIcon: `/Applications/${appName}.app` };
}