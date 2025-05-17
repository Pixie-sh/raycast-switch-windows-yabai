import { Action, ActionPanel, List, LocalStorage, showToast, Toast } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useState, useEffect, useMemo } from "react";
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

  // Load existing usage data from local storage on mount
  useEffect(() => {
    (async () => {
      const storedTimes = await LocalStorage.getItem<string>("usageTimes");
      if (storedTimes) {
        try {
          setUsageTimes(JSON.parse(storedTimes) as Record<string, number>);
        } catch {
          // If parsing fails, ignore and start fresh
        }
      }
    })();
  }, []);

  // Save usageTimes whenever they change
  useEffect(() => {
    LocalStorage.setItem("usageTimes", JSON.stringify(usageTimes));
  }, [usageTimes]);

  // useExec to get your Yabai windows
  const { isLoading, data, error } = useExec<YabaiWindow[]>(
    YABAI,
    ["-m", "query", "--windows"],
    {
      env: ENV,
      parseOutput: ({ stdout }) => {
        if (!stdout) {
          return [];
        }
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

  useEffect(() => {
    if (data !== undefined) {
      setWindows(data);
    } else if (!isLoading && !error) {
      setWindows([]);
    }
  }, [data, isLoading, error]);

  // Filter by search text
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    const lowerQuery = searchText.toLowerCase();

    return windows.filter(
      (win) =>
        win.title.toLowerCase().includes(lowerQuery) ||
        win.app.toLowerCase().includes(lowerQuery)
    );
  }, [windows, searchText]);

  // Sort by most-recently used:
  // usageTimes[win.id] is the timestamp of last focus. More recent => higher in the list
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
            actions={<WindowActions windowId={win.id} windowApp={win.app} onFocused={(id) => {
              // Record the current time for the recently focused window
              setUsageTimes((prev) => ({
                ...prev,
                [id]: Date.now(),
              }));
            }} />}
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
                       }: {
  windowId: number;
  windowApp: string;
  onFocused: (id: number) => void;
}) {
  const handleFocusWindow = async () => {
    await showToast({ style: Toast.Style.Animated, title: "Focusing Window..." });
    try {
      const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "window", "--focus", windowId.toString()], {
        env: ENV,
      });

      if (stderr) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error",
          message: stderr.trim(),
        });
      } else {
        console.log("Yabai output: ", stdout);
        onFocused(windowId);
        await showToast({
          style: Toast.Style.Success,
          title: "Window Focused",
          message: `Window ${windowApp} (yabai id:${windowId})`,
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

  return (
    <ActionPanel>
      <Action title="Switch to Window" onAction={handleFocusWindow} />
    </ActionPanel>
  );
}

function getAppIcon(appName: string) {
  return { fileIcon: `/Applications/${appName}.app` };
}