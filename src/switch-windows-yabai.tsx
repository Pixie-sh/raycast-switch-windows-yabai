import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useState, useEffect, useMemo } from "react";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

interface YabaiWindow {
  id: number;
  app: string;
  title: string;
  // Add other fields you expect from yabai output if needed
  // e.g., space: number, display: number, is-floating: boolean, etc.
}

const execFilePromise = promisify(execFile);
const YABAI = "/opt/homebrew/bin/yabai";
const ENV = {
  USER: "rs",
  HOME: "/Users/rs"
};

export default function Command() {
  console.log("Yabai Windows Command component loaded at:", new Date().toISOString()); // <--- ADD THIS LINE

  const [searchText, setSearchText] = useState("");
  const [windows, setWindows] = useState<YabaiWindow[]>([]);

  // 1) Call yabai, parsing stdout into our Window[] type
  const { isLoading, data, error } = useExec<YabaiWindow[]>(
    YABAI,
    ["-m", "query", "--windows"],
    {
      env: ENV,
      parseOutput: ({ stdout, stderr }) => {
        console.log("yabai raw stdout:", stdout);
        console.log("yabai raw stderr (from parseOutput):", stderr);

        if (stderr) {
          console.error("Error reported by yabai command execution (stderr):", stderr);
        }

        if (!stdout) {
          console.warn("yabai stdout is empty or only whitespace.");
          if (stderr) {
            return [];
          }
          return [];
        }

        try {
          const parsedJson = JSON.parse(stdout);
          // Basic validation: check if it's an array
          if (!Array.isArray(parsedJson)) {
            console.error("Yabai output was not a JSON array. Output:", stdout);
            return [];
          }
          // You could add more specific validation for YabaiWindow fields here if necessary
          return parsedJson as YabaiWindow[];
        } catch (e) {
          console.error("Failed to parse yabai stdout as JSON:", e);
          console.error("Offending stdout content that caused parsing error:", stdout);
          return [];
        }
      },
      initialData: [],
      keepPreviousData: false
    }
  );

  useEffect(() => {
    if (error) {
      console.error("DEBUG: useExec hook error (e.g., command not found, permissions):", error);
    }
  }, [error]);

  useEffect(() => {
    console.log("Data received from useExec (after parseOutput):", data);
    if (data !== undefined) {
      setWindows(data);
    } else if (!isLoading && !error) {
      console.warn("Data is undefined, but not loading and no explicit error. Setting windows to empty.");
      setWindows([]);
    }
  }, [data, isLoading, error]); // Added isLoading and error to dependencies for robustness

  // 3) Filter windows once (memoized) to avoid re-filtering on every keystroke
  const filteredWindows = useMemo(() => {
    if (!Array.isArray(windows)) return []; // Ensure windows is an array
    return windows.filter(
      (win) =>
        (win.title && win.title.toLowerCase().includes(searchText.toLowerCase())) ||
        (win.app && win.app.toLowerCase().includes(searchText.toLowerCase()))
    );
  }, [windows, searchText]);

  return (
    <List isLoading={isLoading} onSearchTextChange={setSearchText} searchBarPlaceholder="Search windows..." throttle>
      <List.Section title="Windows" subtitle={filteredWindows.length.toString()}>
        {filteredWindows.map((win) => (
          <List.Item
            icon={getAppIcon(win.app)}
            key={win.id}
            subtitle={win.title}
            title={win.app}
            actions={<WindowActions windowId={win.id} />}
          />
        ))}
      </List.Section>
      {/* Optionally, show a message if there are no windows and not loading */}
      {!isLoading && filteredWindows.length === 0 && windows.length === 0 && (
        <List.EmptyView
          title="No Windows Found"
          description="Yabai reported no windows, or there was an issue fetching them."
        />
      )}
      {/* Optionally, show a message if there was an error */}
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

function WindowActions({ windowId }: { windowId: number }) {
  const handleFocusWindow = async () => {
    console.log(`Attempting to focus window ID: ${windowId} using path: ${YABAI}`);
    await showToast({ style: Toast.Style.Animated, title: "Focusing Window..." });

    try {
      const { stdout, stderr } = await execFilePromise(
        YABAI,
        ["-m", "window", "--focus", windowId.toString()], // Arguments
        { env: ENV } // Environment variables
      );

      if (stderr) {
        console.error(`yabai focus stderr for window ${windowId}:`, stderr);
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error",
          message: stderr.trim(),
        });
      } else {
        console.log(`yabai focus stdout for window ${windowId}:`, stdout);
        console.log(`Focus command for window ${windowId} completed.`);
        await showToast({
          style: Toast.Style.Success,
          title: "Window Focused",
          message: `Window ID ${windowId}`,
        });
      }
    } catch (error: any) {
      // This catches errors from execFilePromise (e.g., command not found, non-zero exit code)
      console.error(`Error executing yabai to focus window ${windowId}:`, error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Focus Window",
        message: error.message || "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Switching Window" onAction={handleFocusWindow} />
    </ActionPanel>
  );
}

function getAppIcon(appName: string) {
  // Example: if your app name is “Safari”, this points to “/Applications/Safari.app”
  // Adjust the mapping logic as needed if your appName differs from the .app name
  return {
    fileIcon: `/Applications/${appName}.app`,
  };
}
