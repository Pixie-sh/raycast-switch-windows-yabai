import { promisify } from "node:util";
import { exec, execFile } from "node:child_process";
import { showToast, Toast } from "@raycast/api";
import { ENV, YABAI, YabaiSpace, YabaiWindow, Application } from "./models";

const execFilePromise = promisify(execFile);
const execPromise = promisify(exec);

// Focus a window with intelligent fallback to application launch.
export const handleFocusWindow = (windowId: number, windowApp: string, onFocused: (id: number) => void, applications: Application[] = []) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Focusing Window..." });
    try {
      const { stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], {
        env: ENV,
      });
      if (stderr?.trim()) {
        console.log(`Yabai window focus stderr: ${stderr.trim()}`);
        
        // Check if the error indicates window doesn't exist
        if (isWindowNotFoundError(stderr.trim()) || isApplicationNotRunningError(stderr.trim())) {
          console.log(`Window ${windowId} not found, attempting to launch application ${windowApp}`);
          
          // Update toast to indicate switching to app launch
          await showToast({ style: Toast.Style.Animated, title: `Launching ${windowApp}...` });
          
          try {
            const strategy = await launchOrFocusApplication(windowApp, applications);
            await showToast({
              style: Toast.Style.Success,
              title: `${windowApp} launched`,
              message: `Used ${strategy} since no window was found`,
            });
            // Still call onFocused to update usage times, even though we launched instead of focused
            onFocused(windowId);
          } catch (launchError) {
            console.error(`Failed to launch application ${windowApp}:`, launchError);
            await showToast({
              style: Toast.Style.Failure,
              title: "Failed to Launch Application",
              message: `Could not focus window or launch ${windowApp}: ${launchError instanceof Error ? launchError.message : 'Unknown error'}`,
            });
          }
        } else {
          // Other yabai errors that don't indicate missing window
          await showToast({
            style: Toast.Style.Failure,
            title: "Yabai Error - Focus Window",
            message: stderr.trim(),
          });
        }
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: `${windowApp} focused`,
        });
        onFocused(windowId);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error while focusing window";
      console.log(`Yabai window focus exception: ${errorMessage}`);
      
      // Check if the exception also indicates window doesn't exist
      if (isWindowNotFoundError(errorMessage) || isApplicationNotRunningError(errorMessage)) {
        console.log(`Exception indicates window ${windowId} not found, attempting to launch application ${windowApp}`);
        
        // Update toast to indicate switching to app launch
        await showToast({ style: Toast.Style.Animated, title: `Launching ${windowApp}...` });
        
        try {
          const strategy = await launchOrFocusApplication(windowApp, applications);
          await showToast({
            style: Toast.Style.Success,
            title: `${windowApp} launched`,
            message: `Used ${strategy} since no window was found`,
          });
          // Still call onFocused to update usage times, even though we launched instead of focused
          onFocused(windowId);
        } catch (launchError) {
          console.error(`Failed to launch application ${windowApp}:`, launchError);
          await showToast({
            style: Toast.Style.Failure,
            title: "Failed to Launch Application",
            message: `Could not focus window or launch ${windowApp}: ${launchError instanceof Error ? launchError.message : 'Unknown error'}`,
          });
        }
      } else {
        // Other errors that don't indicate missing window
        await showToast({
          style: Toast.Style.Failure,
          title: `Failed Window ${windowApp} (${windowId}) focus`,
          message: errorMessage,
        });
      }
    }
  };
};

// Close a window and remove it from the list.
export const handleCloseWindow = (windowId: number, windowApp: string, onRemove: (id: number) => void) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Closing Window..." });
    try {
      const { stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--close"], {
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
    } catch (error: unknown) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Close Window",
        message: error instanceof Error ? error.message : "Unknown error while closing window",
      });
    }
  };
};

// Aggregate all windows with the same app name into an empty or newly created space.
export const handleAggregateToSpace = (windowId: number, windowApp: string) => {
  return async () => {
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
      // Ensure stdout is a string before parsing
      const currentWinStdout =
        typeof currentWinResult.stdout === "string" ? currentWinResult.stdout : JSON.stringify(currentWinResult.stdout);
      const currentWin: YabaiWindow = JSON.parse(currentWinStdout);
      const currentSpace = currentWin.space;
      console.log("Current space:", currentSpace);

      // Step 2: Query all windows and count those in the current space.
      const allWinsResult = await execFilePromise(YABAI, ["-m", "query", "--windows"], { env: ENV });
      // Ensure stdout is a string before parsing
      const allWinsStdout =
        typeof allWinsResult.stdout === "string" ? allWinsResult.stdout : JSON.stringify(allWinsResult.stdout);
      const allWindows: YabaiWindow[] = JSON.parse(allWinsStdout);
      const windowsInCurrentSpace = allWindows.filter((w) => w.space === currentSpace);
      console.log("Windows in current space:", windowsInCurrentSpace.length);

      if (windowsInCurrentSpace.length < 2) {
        await showToast({
          style: Toast.Style.Success,
          title: "Nothing to Aggregate",
          message: "The current space contains only one window.",
        });
        return;
      }

      // Step 3: Find an empty space.
      const spacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
      // Ensure stdout is a string before parsing
      const spacesStdout =
        typeof spacesResult.stdout === "string" ? spacesResult.stdout : JSON.stringify(spacesResult.stdout);
      const spaces: YabaiSpace[] = JSON.parse(spacesStdout);
      let targetSpace = spaces.find((s) => Array.isArray(s.windows) && s.windows.length === 0);

      // Step 4: Create a new space if no empty one is found.
      if (!targetSpace) {
        const createResult = await execFilePromise(YABAI, ["-m", "space", "--create"], { env: ENV });
        console.log("Space creation output:", createResult.stdout);
        const spacesResultAfter = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
        // Ensure stdout is a string before parsing
        const spacesResultAfterStdout =
          typeof spacesResultAfter.stdout === "string"
            ? spacesResultAfter.stdout
            : JSON.stringify(spacesResultAfter.stdout);
        const updatedSpaces: YabaiSpace[] = JSON.parse(spacesResultAfterStdout);
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
        } catch (innerError: unknown) {
          console.error(
            `Exception while moving window ${win.id}: ${innerError instanceof Error ? innerError.message : "Unknown error"}`,
          );
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
    } catch (error: unknown) {
      console.error("Aggregation failed:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Aggregation Failed",
        message: error instanceof Error ? error.message : "An unknown error occurred during aggregation.",
      });
    }
  };
};

export const handleCloseEmptySpaces = (windowId: number, onRemove: (id: number) => void) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Closing Empty Spaces..." });
    try {
      const command = `${YABAI} -m query --spaces | jq '.[] | select(.windows | length == 0) | .index' | xargs -I {} ${YABAI} -m space {} --destroy`;
      const { stderr } = await execPromise(command, { env: ENV });
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
    } catch (error: unknown) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Close Empty Spaces",
        message: error instanceof Error ? error.message : "Unknown error while closing window",
      });
    }
  };
};
export const handleMoveWindowToDisplay = (windowId: number, windowApp: string, displayIdx: string) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: `Moving Window to Display #${displayIdx}...` });
    try {
      // Move the window to the specified display
      const { stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--display", displayIdx], {
        env: ENV,
      });

      if (stderr?.trim()) {
        console.error(`Error moving window ${windowId}: ${stderr.trim()}`);
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error - Move Window",
          message: stderr.trim(),
        });
      } else {
        console.log(`Moved window ${windowId} to display ${displayIdx}.`);

        // Focus the window after moving it
        await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], { env: ENV });

        await showToast({
          style: Toast.Style.Success,
          title: `Window Moved`,
          message: `${windowApp} has been moved to display #${displayIdx} and focused.`,
        });
      }
    } catch (error: unknown) {
      console.error("Move window failed:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Move Window Failed",
        message: error instanceof Error ? error.message : "An unknown error occurred while moving the window.",
      });
    }
  };
};

export const handleDisperseWindowsBySpace = (screenIdx: string) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Dispersing Windows Across Spaces..." });
    try {
      // Step 1: Query all windows on the given display
      const windowsResult = await execFilePromise(YABAI, ["-m", "query", "--windows", "--display", screenIdx], {
        env: ENV,
      });

      // Ensure stdout is a string before parsing
      const windowsStdout =
        typeof windowsResult.stdout === "string" ? windowsResult.stdout : JSON.stringify(windowsResult.stdout);
      // Filter out windows in native MacOS fullscreen mode
      const allWindows = JSON.parse(windowsStdout);
      const windows: YabaiWindow[] = allWindows.filter((win: YabaiWindow) => !win["is-native-fullscreen"]);

      // Step 2: Query all spaces on the given display
      const spacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--display", screenIdx], {
        env: ENV,
      });
      // Ensure stdout is a string before parsing
      const spacesStdout =
        typeof spacesResult.stdout === "string" ? spacesResult.stdout : JSON.stringify(spacesResult.stdout);
      let spaces: YabaiSpace[] = JSON.parse(spacesStdout);

      // Step 3: Create new spaces if needed so that each window has a space
      const spacesToCreate = windows.length - spaces.length - 1;
      if (spacesToCreate > 0) {
        for (let i = 0; i < spacesToCreate; i++) {
          await execFilePromise(YABAI, ["-m", "space", "--create"], { env: ENV });
        }
        // Re-query spaces after creation
        const updatedSpacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
        // Ensure stdout is a string before parsing
        const updatedSpacesStdout =
          typeof updatedSpacesResult.stdout === "string"
            ? updatedSpacesResult.stdout
            : JSON.stringify(updatedSpacesResult.stdout);
        spaces = JSON.parse(updatedSpacesStdout);
      }

      // Step 4: Disperse each window to its corresponding space
      for (let i = 0; i < windows.length - 1; i++) {
        const window = windows[i];
        const space = spaces[i];

        // Move the window into the corresponding space
        const moveResult = await execFilePromise(
          YABAI,
          ["-m", "window", window.id.toString(), "--space", space.index.toString()],
          { env: ENV },
        );

        if (moveResult.stderr?.trim()) {
          console.error(`Error moving window ${window.id}: ${moveResult.stderr.trim()}`);
        } else {
          console.log(`Moved window ${window.id} to space ${space.index}.`);
        }
      }

      try {
        // Added: Focus on the first space to ensure a target for focus exists.
        await execFilePromise(YABAI, ["-m", "space", "--focus", "1"], { env: ENV });
      } catch {
        /*ignore, error will be thrown*/
      }

      await showToast({
        style: Toast.Style.Success,
        title: `Dispersal for Display #${screenIdx} complete`,
        message: "Windows have been evenly distributed and the first space is focused.",
      });
    } catch (error: unknown) {
      console.error("Dispersal failed:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Dispersal Failed",
        message: error instanceof Error ? error.message : "An unknown error occurred during dispersal.",
      });
    }
  };
};

// Move window to an empty space on the current display, or create a new space if none exists
export const handleMoveToDisplaySpace = (windowId: number, windowApp: string) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Moving Window to Display Space..." });
    try {
      // Step 1: Get the current window info to determine its display
      const windowResult = await execFilePromise(YABAI, ["-m", "query", "--windows", "--window", windowId.toString()], {
        env: ENV,
      });

      const windowStdout =
        typeof windowResult.stdout === "string" ? windowResult.stdout : JSON.stringify(windowResult.stdout);
      const windowInfo: YabaiWindow = JSON.parse(windowStdout);
      const currentDisplay = windowInfo.display;

      console.log(`Window ${windowId} is on display ${currentDisplay}`);

      // Step 2: Query all spaces to find empty ones on the current display
      const spacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
      const spacesStdout =
        typeof spacesResult.stdout === "string" ? spacesResult.stdout : JSON.stringify(spacesResult.stdout);
      const allSpaces: YabaiSpace[] = JSON.parse(spacesStdout);

      // Find empty spaces on the current display
      const emptySpacesOnDisplay = allSpaces.filter(
        (space) => space.display === currentDisplay && Array.isArray(space.windows) && space.windows.length === 0,
      );

      let targetSpaceIndex: number;

      if (emptySpacesOnDisplay.length > 0) {
        // Use the first empty space found
        targetSpaceIndex = emptySpacesOnDisplay[0].index;
        console.log(`Found empty space ${targetSpaceIndex} on display ${currentDisplay}`);
      } else {
        // Create a new space
        console.log(`No empty spaces found on display ${currentDisplay}, creating new space`);
        await execFilePromise(YABAI, ["-m", "space", "--create"], { env: ENV });

        // Re-query spaces to get the newly created space
        const updatedSpacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces"], { env: ENV });
        const updatedSpacesStdout =
          typeof updatedSpacesResult.stdout === "string"
            ? updatedSpacesResult.stdout
            : JSON.stringify(updatedSpacesResult.stdout);
        const updatedSpaces: YabaiSpace[] = JSON.parse(updatedSpacesStdout);

        // Find the newly created empty space on the current display
        const newEmptySpaces = updatedSpaces.filter(
          (space) => space.display === currentDisplay && Array.isArray(space.windows) && space.windows.length === 0,
        );

        if (newEmptySpaces.length > 0) {
          targetSpaceIndex = newEmptySpaces[0].index;
          console.log(`Created new space ${targetSpaceIndex} on display ${currentDisplay}`);
        } else {
          throw new Error("Failed to create or find empty space");
        }
      }

      // Step 3: Move the window to the target space
      const moveResult = await execFilePromise(
        YABAI,
        ["-m", "window", windowId.toString(), "--space", targetSpaceIndex.toString()],
        { env: ENV },
      );

      if (moveResult.stderr?.trim()) {
        console.error(`Error moving window ${windowId}: ${moveResult.stderr.trim()}`);
        await showToast({
          style: Toast.Style.Failure,
          title: "Yabai Error - Move Window to Space",
          message: moveResult.stderr.trim(),
        });
        return;
      }

      // Step 4: Focus the target space
      await execFilePromise(YABAI, ["-m", "space", "--focus", targetSpaceIndex.toString()], { env: ENV });

      // Step 5: Focus the window
      await execFilePromise(YABAI, ["-m", "window", "--focus", "first"], { env: ENV });

      console.log(`Successfully moved window ${windowId} to space ${targetSpaceIndex} on display ${currentDisplay}`);

      await showToast({
        style: Toast.Style.Success,
        title: "Window Moved to Display Space",
        message: `${windowApp} has been moved to ${emptySpacesOnDisplay.length > 0 ? "an empty" : "a new"} space on the current display and focused.`,
      });
    } catch (error: unknown) {
      console.error("Move to display space failed:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Move to Display Space Failed",
        message:
          error instanceof Error
            ? error.message
            : "An unknown error occurred while moving the window to display space.",
      });
    }
  };
};

// Utility Functions for Application Management and Window Fallback

/**
 * Check if yabai error indicates window not found
 */
export function isWindowNotFoundError(error: string): boolean {
  const windowNotFoundIndicators = [
    "could not locate the window with the specified id",
    "window not found",
    "invalid window id",
    "no such window",
    "window does not exist",
  ];
  const errorLower = error.toLowerCase();
  return windowNotFoundIndicators.some(indicator => errorLower.includes(indicator));
}

/**
 * Check if yabai error indicates general application not found/not running
 */
export function isApplicationNotRunningError(error: string): boolean {
  const appNotRunningIndicators = [
    "application not running",
    "no such application",
    "app not found",
    "application is not running",
  ];
  const errorLower = error.toLowerCase();
  return appNotRunningIndicators.some(indicator => errorLower.includes(indicator));
}

/**
 * Validate if a window still exists in yabai
 */
export async function validateWindowExists(windowId: number): Promise<boolean> {
  try {
    await execFilePromise(YABAI, ["-m", "query", "--windows", "--window", windowId.toString()], {
      env: ENV,
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get application path from applications list
 */
export function getApplicationPath(appName: string, applications: Application[]): string | null {
  const app = applications.find(app => 
    app.name.toLowerCase() === appName.toLowerCase() ||
    app.name.toLowerCase().includes(appName.toLowerCase()) ||
    appName.toLowerCase().includes(app.name.toLowerCase())
  );
  return app?.path || null;
}

/**
 * Launch application using macOS open command
 */
export async function launchApplicationByName(appName: string): Promise<void> {
  try {
    // First try using the app name directly
    await execPromise(`open -a "${appName}"`, { env: ENV });
    console.log(`Successfully launched ${appName} using open -a`);
  } catch (error) {
    console.error(`Failed to launch ${appName} with open -a:`, error);
    throw error;
  }
}

/**
 * Launch application using full path
 */
export async function launchApplicationByPath(appPath: string): Promise<void> {
  try {
    await execPromise(`open "${appPath}"`, { env: ENV });
    console.log(`Successfully launched app at ${appPath}`);
  } catch (error) {
    console.error(`Failed to launch app at ${appPath}:`, error);
    throw error;
  }
}

/**
 * Focus application using AppleScript as fallback
 */
export async function focusApplicationWithAppleScript(appName: string): Promise<void> {
  try {
    const script = `tell application "${appName}" to activate`;
    await execPromise(`osascript -e '${script}'`, { env: ENV });
    console.log(`Successfully focused ${appName} using AppleScript`);
  } catch (error) {
    console.error(`Failed to focus ${appName} with AppleScript:`, error);
    throw error;
  }
}

/**
 * Comprehensive application launch/focus with multiple fallback strategies
 */
export async function launchOrFocusApplication(appName: string, applications: Application[]): Promise<string> {
  const strategies: Array<{ name: string; action: () => Promise<void> }> = [
    {
      name: "open -a command",
      action: () => launchApplicationByName(appName)
    }
  ];

  // Add path-based launch if we have the path
  const appPath = getApplicationPath(appName, applications);
  if (appPath) {
    strategies.push({
      name: "path-based launch",
      action: () => launchApplicationByPath(appPath)
    });
  }

  // Add AppleScript as final fallback
  strategies.push({
    name: "AppleScript activation",
    action: () => focusApplicationWithAppleScript(appName)
  });

  let lastError: Error | null = null;
  
  for (const strategy of strategies) {
    try {
      await strategy.action();
      return strategy.name; // Return the successful strategy name
    } catch (error) {
      console.log(`Strategy '${strategy.name}' failed:`, error);
      lastError = error instanceof Error ? error : new Error(String(error));
      continue; // Try next strategy
    }
  }

  throw lastError || new Error("All application launch strategies failed");
}
