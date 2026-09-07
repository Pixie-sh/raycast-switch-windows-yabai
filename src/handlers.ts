import { promisify } from "node:util";
import { execFile, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { closeMainWindow, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { ENV, YABAI, YabaiSpace, YabaiWindow, Application, DisplayInfo } from "./models";
import { EXEC_FILE_OPTIONS } from "./utils/command";
import {
  parseYabaiDisplay,
  parseYabaiDisplays,
  parseYabaiSpace,
  parseYabaiSpaces,
  parseYabaiWindow,
  parseYabaiWindows,
} from "./utils/runtimeData";
import {
  createSpaceOnDisplay as createSpaceOnDisplaySafely,
  getAdjacentSpace,
  isSameWindowIdentity,
  isUnsafeSpaceIndexMutationDisabled,
  planAggregation,
  planDispersal,
} from "./utils/windowOperations";

const rawExecFilePromise = promisify(execFile);
type StringExecFileOptions = Partial<ExecFileOptionsWithStringEncoding>;
const execFilePromise = (file: string, args: string[], options: StringExecFileOptions = {}) =>
  rawExecFilePromise(file, args, {
    ...EXEC_FILE_OPTIONS,
    ...options,
    encoding: "utf8",
  } as ExecFileOptionsWithStringEncoding);

function outputString(output: string | Buffer): string {
  return typeof output === "string" ? output : output.toString();
}

async function queryExpectedWindow(expected: Pick<YabaiWindow, "id" | "app" | "title">): Promise<YabaiWindow> {
  const result = await execFilePromise(YABAI, ["-m", "query", "--windows", "--window", String(expected.id)], {
    env: ENV,
    encoding: "utf8",
  });
  if (result.stderr.trim()) throw new Error(result.stderr.trim());
  const live = parseYabaiWindow(outputString(result.stdout)) as YabaiWindow;
  if (!isSameWindowIdentity(expected, live)) {
    throw new Error("Selected window identity changed; refresh and try again");
  }
  return live;
}

/**
 * Check if an application is a utility app that requires executable launch
 * Utility apps often can't be focused by yabai due to macOS restrictions
 */
function isUtilityApp(appName: string): boolean {
  const utilityApps = [
    "Activity Monitor",
    "Console",
    "Disk Utility",
    "Terminal",
    "System Information",
    "Network Utility",
    "Keychain Access",
    "Migration Assistant",
    "ColorSync Utility",
    "VoiceOver Utility",
    "Audio MIDI Setup",
    "Bluetooth File Exchange",
    "AirPort Utility",
    "Grapher",
  ];
  return utilityApps.some((utilityApp) => appName.toLowerCase().includes(utilityApp.toLowerCase()));
}

// Focus a window with intelligent fallback to application launch.
export const handleFocusWindow = (
  windowId: number,
  windowApp: string,
  onFocused: (id: number) => void | Promise<void>,
  applications: Application[] = [],
  expectedTitle?: string,
) => {
  return async () => {
    // Check if this is a utility app that requires special handling
    const isUtility = isUtilityApp(windowApp);

    if (isUtility) {
      console.log(`${windowApp} is a utility app, launching executable instead of focusing window`);
      await showToast({ style: Toast.Style.Animated, title: `Launching ${windowApp}...` });

      try {
        const strategy = await launchOrFocusApplication(windowApp, applications);
        await closeMainWindow();
        await showToast({
          style: Toast.Style.Success,
          title: `${windowApp} activated`,
          message: `Used ${strategy} (utility app)`,
        });
      } catch (launchError) {
        console.error(`Failed to launch utility app ${windowApp}:`, launchError);
        await showFailureToast(launchError, { title: "Failed to Activate Utility App" });
      }
      return;
    }

    try {
      if (expectedTitle === undefined) throw new Error("Window title is required to verify identity");
      await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });

      // Close Raycast before focus so it cannot steal focus back.
      await closeMainWindow();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], {
        env: ENV,
      });
      if (stderr?.trim()) {
        console.log(`Yabai window focus stderr: ${stderr.trim()}`);

        // Check if the error indicates window doesn't exist
        if (isWindowNotFoundError(stderr.trim()) || isApplicationNotRunningError(stderr.trim())) {
          console.log(`Window ${windowId} not found, attempting to launch application ${windowApp}`);

          try {
            const strategy = await launchOrFocusApplication(windowApp, applications);
            await showToast({
              style: Toast.Style.Success,
              title: `${windowApp} launched`,
              message: `Used ${strategy} since no window was found`,
            });
          } catch (launchError) {
            console.error(`Failed to launch application ${windowApp}:`, launchError);
            await showFailureToast(launchError, { title: "Failed to Launch Application" });
          }
        } else {
          // Other yabai errors that don't indicate missing window
          await showFailureToast(new Error(stderr.trim()), { title: "Yabai Error - Focus Window" });
        }
      } else {
        // First focus succeeded. Issue a second focus request after a short delay to
        // work around intermittent cases where macOS/yabai doesn't fully commit the
        // focus on the first call (e.g. cross-space or cross-display switches).
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          const { stderr: stderr2 } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], {
            env: ENV,
          });
          if (stderr2?.trim()) {
            // Log but don't surface — the first call already succeeded and the window
            // may have been legitimately closed/moved between the two calls.
            console.log(`Yabai window focus retry stderr (non-fatal): ${stderr2.trim()}`);
          }
        } catch (retryError) {
          // Non-fatal: first call succeeded, retry is best-effort.
          console.log(
            `Yabai window focus retry exception (non-fatal): ${
              retryError instanceof Error ? retryError.message : retryError
            }`,
          );
        }
        await onFocused(windowId);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error while focusing window";
      console.log(`Yabai window focus exception: ${errorMessage}`);

      // Check if the exception also indicates window doesn't exist
      if (isWindowNotFoundError(errorMessage) || isApplicationNotRunningError(errorMessage)) {
        console.log(`Exception indicates window ${windowId} not found, attempting to launch application ${windowApp}`);

        try {
          const strategy = await launchOrFocusApplication(windowApp, applications);
          await showToast({
            style: Toast.Style.Success,
            title: `${windowApp} launched`,
            message: `Used ${strategy} since no window was found`,
          });
        } catch (launchError) {
          console.error(`Failed to launch application ${windowApp}:`, launchError);
          await showFailureToast(launchError, { title: "Failed to Launch Application" });
        }
      } else {
        // Other errors that don't indicate missing window
        await showFailureToast(error, { title: `Failed Window ${windowApp} (${windowId}) focus` });
      }
    }
  };
};

// Aggregate all windows with the same app name into an empty or newly created space.
export const handleAggregateToSpace = (windowId: number, windowApp: string, expectedTitle: string) => {
  return async () => {
    if (isUnsafeSpaceIndexMutationDisabled()) {
      await showFailureToast(
        new Error("Aggregation is disabled because yabai space indices can renumber during the operation"),
        {
          title: "Aggregation Disabled for Safety",
        },
      );
      return;
    }
    await showToast({ style: Toast.Style.Animated, title: "Aggregating Windows..." });
    try {
      const selectedWindow = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });
      const windowsResult = await execFilePromise(YABAI, ["-m", "query", "--windows"], {
        env: ENV,
        encoding: "utf8",
      });
      const allWindows = parseYabaiWindows(outputString(windowsResult.stdout));
      const spacesResult = await execFilePromise(
        YABAI,
        ["-m", "query", "--spaces", "--display", String(selectedWindow.display)],
        { env: ENV, encoding: "utf8" },
      );
      const spaces = parseYabaiSpaces(outputString(spacesResult.stdout));
      let plan = planAggregation(allWindows, spaces, selectedWindow);
      if (plan.matchingWindowIds.length < 2) {
        await showToast({
          style: Toast.Style.Success,
          title: "Nothing to Aggregate",
          message: `Only one ${windowApp} window is open`,
        });
        return;
      }

      if (plan.needsCreate) {
        const created = await createSpaceOnDisplay(plan.targetDisplay);
        plan = { ...plan, targetSpaceIndex: created.index, needsCreate: false };
      }

      if (plan.targetSpaceIndex === undefined) throw new Error("No target space available");
      const failures: string[] = [];
      const movedIds: number[] = [];
      const expectedById = new Map(allWindows.map((window) => [window.id, window]));
      for (const id of plan.matchingWindowIds) {
        try {
          const expected = expectedById.get(id);
          if (!expected) throw new Error("Window identity was not captured");
          await queryExpectedWindow(expected as YabaiWindow);
          const move = await execFilePromise(
            YABAI,
            ["-m", "window", String(id), "--space", String(plan.targetSpaceIndex)],
            { env: ENV, encoding: "utf8" },
          );
          if (move.stderr.trim()) throw new Error(move.stderr.trim());
          movedIds.push(id);
        } catch (error) {
          failures.push(`window ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (movedIds.length > 0) {
        await execFilePromise(YABAI, ["-m", "space", "--focus", String(plan.targetSpaceIndex)], {
          env: ENV,
          encoding: "utf8",
        });
        await execFilePromise(YABAI, ["-m", "window", String(movedIds[0]), "--focus"], {
          env: ENV,
          encoding: "utf8",
        });
      }
      if (failures.length > 0) {
        await showFailureToast(new Error(failures.join("; ")), {
          title: `Moved ${movedIds.length} of ${plan.matchingWindowIds.length} ${windowApp} Windows`,
        });
        return;
      }
      await showToast({
        style: Toast.Style.Success,
        title: "Aggregation Complete",
        message: `${movedIds.length} ${windowApp} windows moved to space ${plan.targetSpaceIndex}`,
      });
    } catch (error: unknown) {
      console.error("Aggregation failed:", error);
      await showFailureToast(error, { title: "Aggregation Failed" });
    }
  };
};

export const handleMoveWindowToDisplay = (
  windowId: number,
  windowApp: string,
  expectedTitle: string,
  displayIdx: string,
) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: `Moving Window to Display #${displayIdx}...` });
    try {
      const targetDisplay = Number(displayIdx);
      if (!Number.isInteger(targetDisplay) || targetDisplay < 1) throw new Error(`Invalid display: ${displayIdx}`);
      const liveWindow = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });
      if (liveWindow.display === targetDisplay) return;

      const { stderr } = await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--display", displayIdx], {
        env: ENV,
      });

      if (stderr?.trim()) {
        console.error(`Error moving window ${windowId}: ${stderr.trim()}`);
        await showFailureToast(new Error(stderr.trim()), { title: "Yabai Error - Move Window" });
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
      await showFailureToast(error, { title: "Move Window Failed" });
    }
  };
};

export const handleDisperseWindowsBySpace = (screenIdx: string) => {
  return async () => {
    if (isUnsafeSpaceIndexMutationDisabled()) {
      await showFailureToast(
        new Error("Dispersal is disabled because yabai space indices can renumber during the operation"),
        {
          title: "Dispersal Disabled for Safety",
        },
      );
      return;
    }
    await showToast({ style: Toast.Style.Animated, title: "Dispersing Windows Across Spaces..." });
    try {
      const display = Number(screenIdx);
      if (!Number.isInteger(display) || display < 1) throw new Error(`Invalid display index: ${screenIdx}`);
      const windowsResult = await execFilePromise(YABAI, ["-m", "query", "--windows", "--display", screenIdx], {
        env: ENV,
        encoding: "utf8",
      });
      const windows = parseYabaiWindows(outputString(windowsResult.stdout));
      const spacesResult = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--display", screenIdx], {
        env: ENV,
        encoding: "utf8",
      });
      let spaces = parseYabaiSpaces(outputString(spacesResult.stdout));
      const initialPlan = planDispersal(windows, spaces, display);

      if (initialPlan.spacesNeeded > 0) {
        for (let index = 0; index < initialPlan.spacesNeeded; index += 1) {
          await createSpaceOnDisplay(display);
        }
        const updated = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--display", screenIdx], {
          env: ENV,
          encoding: "utf8",
        });
        spaces = parseYabaiSpaces(outputString(updated.stdout));
      }

      const plan = planDispersal(windows, spaces, display);
      if (plan.assignments.length === 0) {
        await showToast({
          style: Toast.Style.Success,
          title: "Nothing to Disperse",
          message: `No eligible windows on Display ${display}`,
        });
        return;
      }

      const failures: string[] = [];
      let moved = 0;
      const expectedById = new Map(windows.map((window) => [window.id, window]));
      for (const assignment of plan.assignments) {
        try {
          const expected = expectedById.get(assignment.windowId);
          if (!expected) throw new Error("Window identity was not captured");
          await queryExpectedWindow(expected as YabaiWindow);
          const result = await execFilePromise(
            YABAI,
            ["-m", "window", assignment.windowId.toString(), "--space", assignment.spaceIndex.toString()],
            { env: ENV, encoding: "utf8" },
          );
          if (result.stderr.trim()) throw new Error(result.stderr.trim());
          moved += 1;
        } catch (error) {
          failures.push(`window ${assignment.windowId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (plan.focusSpaceIndex !== undefined) {
        await execFilePromise(YABAI, ["-m", "space", "--focus", plan.focusSpaceIndex.toString()], {
          env: ENV,
          encoding: "utf8",
        });
      }
      if (failures.length > 0) {
        await showFailureToast(new Error(failures.join("; ")), {
          title: `Moved ${moved} of ${plan.assignments.length} Windows`,
        });
        return;
      }
      await showToast({
        style: Toast.Style.Success,
        title: `Dispersal for Display #${display} Complete`,
        message: `${moved} window${moved === 1 ? "" : "s"} distributed across local spaces`,
      });
    } catch (error: unknown) {
      console.error("Dispersal failed:", error);
      await showFailureToast(error, { title: "Dispersal Failed" });
    }
  };
};

async function querySpacesOnDisplay(display: number): Promise<YabaiSpace[]> {
  const result = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--display", String(display)], {
    env: ENV,
    encoding: "utf8",
  });
  return parseYabaiSpaces(outputString(result.stdout)) as YabaiSpace[];
}

async function createSpaceOnDisplay(display: number): Promise<YabaiSpace> {
  return createSpaceOnDisplaySafely(
    display,
    () => querySpacesOnDisplay(display),
    (args) => execFilePromise(YABAI, args, { env: ENV, encoding: "utf8" }),
  );
}

/**
 * Open a window in a new space on its display, or launch an app on the focused display.
 */
export const handleOpenWindowInNewSpace = (windowId: number, windowApp: string, expectedTitle?: string) => {
  return async () => {
    await showToast({ style: Toast.Style.Animated, title: "Opening in New Space..." });
    let createdSpace: YabaiSpace | undefined;
    try {
      let targetDisplay: number;
      let expectedWindow: YabaiWindow | undefined;
      const windowExists = windowId > 0;
      if (windowExists) {
        if (expectedTitle === undefined) throw new Error("Window title is required to verify identity");
        const window = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });
        if (!window.display) throw new Error("Selected window has no display");
        expectedWindow = window;
        targetDisplay = window.display;
      } else {
        const result = await execFilePromise(YABAI, ["-m", "query", "--displays", "--display"], {
          env: ENV,
          encoding: "utf8",
        });
        targetDisplay = parseYabaiDisplay(outputString(result.stdout)).index;
      }

      createdSpace = await createSpaceOnDisplay(targetDisplay);
      if (windowExists) {
        if (!expectedWindow) throw new Error("Window identity was not captured");
        await queryExpectedWindow(expectedWindow);
        const move = await execFilePromise(
          YABAI,
          ["-m", "window", String(windowId), "--space", String(createdSpace.index)],
          { env: ENV, encoding: "utf8" },
        );
        if (move.stderr.trim()) throw new Error(move.stderr.trim());
      }
      await execFilePromise(YABAI, ["-m", "space", "--focus", String(createdSpace.index)], {
        env: ENV,
        encoding: "utf8",
      });
      if (windowExists) {
        await execFilePromise(YABAI, ["-m", "window", String(windowId), "--focus"], {
          env: ENV,
          encoding: "utf8",
        });
      } else {
        await execFilePromise("/usr/bin/open", ["-a", windowApp], { env: ENV, encoding: "utf8" });
      }
      await showToast({
        style: Toast.Style.Success,
        title: windowExists ? "Window Opened in New Space" : "Application Launched in New Space",
        message: `${windowApp} ${windowExists ? "moved to" : "launched in"} space ${createdSpace.index} on Display ${targetDisplay}`,
      });
    } catch (error: unknown) {
      console.error("Open in new space failed:", error);
      await showFailureToast(error, { title: "Open in New Space Failed" });
    }
  };
};

// Move window to an empty space on its display, or create one there if needed.
export const handleMoveToDisplaySpace = (windowId: number, windowApp: string, expectedTitle: string) => {
  return async () => {
    if (isUnsafeSpaceIndexMutationDisabled()) {
      await showFailureToast(
        new Error("Empty-space moves are disabled because yabai space indices can renumber during the operation"),
        {
          title: "Empty-Space Move Disabled for Safety",
        },
      );
      return;
    }
    await showToast({ style: Toast.Style.Animated, title: "Moving Window to Display Space..." });
    let createdSpace: YabaiSpace | undefined;
    try {
      const window = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });
      if (!window.display) throw new Error("Selected window has no display");
      const localSpaces = await querySpacesOnDisplay(window.display);
      let target = localSpaces
        .filter((space) => space.windows.length === 0)
        .sort((left, right) => left.index - right.index)[0];
      if (!target) {
        createdSpace = await createSpaceOnDisplay(window.display);
        target = createdSpace;
      } else {
        const current = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--space", String(target.index)], {
          env: ENV,
          encoding: "utf8",
        });
        const revalidated = parseYabaiSpace(outputString(current.stdout));
        if (revalidated.index !== target.index || revalidated.windows.length > 0) {
          createdSpace = await createSpaceOnDisplay(window.display);
          target = createdSpace;
        }
      }

      await queryExpectedWindow(window as YabaiWindow);
      const move = await execFilePromise(YABAI, ["-m", "window", String(windowId), "--space", String(target.index)], {
        env: ENV,
        encoding: "utf8",
      });
      if (move.stderr.trim()) throw new Error(move.stderr.trim());
      await execFilePromise(YABAI, ["-m", "space", "--focus", String(target.index)], {
        env: ENV,
        encoding: "utf8",
      });
      await execFilePromise(YABAI, ["-m", "window", String(windowId), "--focus"], {
        env: ENV,
        encoding: "utf8",
      });
      await showToast({
        style: Toast.Style.Success,
        title: "Window Moved to Display Space",
        message: `${windowApp} moved to ${createdSpace ? "new" : "empty"} space ${target.index} on Display ${window.display}`,
      });
    } catch (error: unknown) {
      console.error("Move to display space failed:", error);
      await showFailureToast(error, { title: "Move to Display Space Failed" });
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
  return windowNotFoundIndicators.some((indicator) => errorLower.includes(indicator));
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
  return appNotRunningIndicators.some((indicator) => errorLower.includes(indicator));
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
  } catch {
    return false;
  }
}

/**
 * Get application path from applications list
 */
export function getApplicationPath(appName: string, applications: Application[]): string | null {
  const app = applications.find(
    (app) =>
      (app.name || "").toLowerCase() === appName.toLowerCase() ||
      (app.name || "").toLowerCase().includes(appName.toLowerCase()) ||
      appName.toLowerCase().includes((app.name || "").toLowerCase()),
  );
  return app?.path || null;
}

/**
 * Launch application using macOS open command
 */
export async function launchApplicationByName(appName: string): Promise<void> {
  try {
    // First try using the app name directly
    await execFilePromise("/usr/bin/open", ["-a", appName], { env: ENV, encoding: "utf8" });
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
    await execFilePromise("/usr/bin/open", [appPath], { env: ENV, encoding: "utf8" });
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
    await execFilePromise("/usr/bin/open", ["-a", appName], { env: ENV, encoding: "utf8" });
  } catch (error) {
    console.error(`Failed to activate ${appName}:`, error);
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
      action: () => launchApplicationByName(appName),
    },
  ];

  // Add path-based launch if we have the path
  const appPath = getApplicationPath(appName, applications);
  if (appPath) {
    strategies.push({
      name: "path-based launch",
      action: () => launchApplicationByPath(appPath),
    });
  }

  // Add AppleScript as final fallback
  strategies.push({
    name: "AppleScript activation",
    action: () => focusApplicationWithAppleScript(appName),
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

// New Functions for Interactive Display Selection

/**
 * Query all available displays and return formatted information
 * @returns Array of DisplayInfo objects with display details
 */
export async function getAvailableDisplays(): Promise<DisplayInfo[]> {
  try {
    const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "query", "--displays"], {
      env: ENV,
    });

    if (stderr?.trim()) {
      console.error(`Error querying displays: ${stderr.trim()}`);
      throw new Error(stderr.trim());
    }

    const displays = parseYabaiDisplays(outputString(stdout));

    return displays.map((display) => ({
      index: display.index,
      label: display.label || `Display ${display.index}`,
      dimensions: `${display.frame.w}×${display.frame.h}`,
      isFocused: display["has-focus"] || false,
    }));
  } catch (error: unknown) {
    console.error("Failed to query displays:", error);
    throw error instanceof Error ? error : new Error("Failed to query displays");
  }
}

/**
 * Move window to a specific display with interactive selection
 * @param windowId - The ID of the window to move
 * @param windowApp - The name of the application (for notifications)
 * @param displayIndex - The target display index
 */
export const handleInteractiveMoveToDisplay = (
  windowId: number,
  windowApp: string,
  expectedTitle: string,
  displayIndex: number,
) => {
  return async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: `Moving to Display ${displayIndex}...`,
    });

    try {
      const liveWindow = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });
      if (liveWindow.display === displayIndex) return;

      const { stderr } = await execFilePromise(
        YABAI,
        ["-m", "window", windowId.toString(), "--display", displayIndex.toString()],
        { env: ENV },
      );

      if (stderr?.trim()) {
        console.error(`Error moving window ${windowId} to display ${displayIndex}: ${stderr.trim()}`);
        await showFailureToast(new Error(stderr.trim()), { title: "Move Failed" });
        return;
      }

      // Focus the window after moving it
      try {
        await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], { env: ENV });
      } catch (focusError) {
        console.warn("Failed to focus window after move:", focusError);
        // Don't fail the entire operation if focus fails
      }

      console.log(`Successfully moved window ${windowId} (${windowApp}) to display ${displayIndex}`);

      await showToast({
        style: Toast.Style.Success,
        title: "Window Moved",
        message: `${windowApp} moved to Display ${displayIndex}`,
      });
    } catch (error: unknown) {
      console.error("Interactive move to display failed:", error);
      await showFailureToast(error, { title: "Move Failed" });
    }
  };
};

/**
 * Get the currently focused display index
 * @returns The index of the currently focused display
 */
export async function getFocusedDisplay(): Promise<number> {
  try {
    const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "query", "--displays", "--display"], {
      env: ENV,
    });

    if (stderr?.trim()) {
      console.error(`Error querying focused display: ${stderr.trim()}`);
      throw new Error(stderr.trim());
    }

    const display = parseYabaiDisplay(outputString(stdout));

    return display.index;
  } catch (error: unknown) {
    console.error("Failed to get focused display:", error);
    throw error instanceof Error ? error : new Error("Failed to get focused display");
  }
}

/**
 * Get the currently focused space index
 * @returns The index of the currently focused space
 */
export async function getFocusedSpace(): Promise<number> {
  try {
    const { stdout, stderr } = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--space"], {
      env: ENV,
    });

    if (stderr?.trim()) {
      console.error(`Error querying focused space: ${stderr.trim()}`);
      throw new Error(stderr.trim());
    }

    const space = parseYabaiSpace(outputString(stdout));

    return space.index;
  } catch (error: unknown) {
    console.error("Failed to get focused space:", error);
    throw error instanceof Error ? error : new Error("Failed to get focused space");
  }
}

/**
 * Move window to the currently focused space (not just display)
 * @param windowId - The ID of the window to move
 * @param windowApp - The name of the application (for notifications)
 */
export const handleMoveToFocusedDisplay = (windowId: number, windowApp: string, expectedTitle: string) => {
  return async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: "Moving to Focused Space...",
    });

    try {
      // Get the currently focused space (not just display)
      const focusedSpaceIndex = await getFocusedSpace();

      // Revalidate the selected window immediately before the move.
      const windowInfo = await queryExpectedWindow({ id: windowId, app: windowApp, title: expectedTitle });

      // Check if THIS SPECIFIC WINDOW is already on the focused space
      if (windowInfo.space === focusedSpaceIndex) {
        await showToast({
          style: Toast.Style.Success,
          title: "Already on Focused Space",
          message: `Window "${windowInfo.title}" is already on the focused space`,
        });
        return;
      }

      // Move THIS SPECIFIC WINDOW to the focused space
      const { stderr } = await execFilePromise(
        YABAI,
        ["-m", "window", windowId.toString(), "--space", focusedSpaceIndex.toString()],
        { env: ENV },
      );

      if (stderr?.trim()) {
        console.error(`Error moving window ${windowId} to focused space ${focusedSpaceIndex}: ${stderr.trim()}`);
        await showFailureToast(new Error(stderr.trim()), { title: "Move Failed" });
        return;
      }

      // Focus the window after moving it
      try {
        await execFilePromise(YABAI, ["-m", "window", windowId.toString(), "--focus"], { env: ENV });
      } catch (focusError) {
        console.warn("Failed to focus window after move:", focusError);
        // Don't fail the entire operation if focus fails
      }

      console.log(
        `Successfully moved window ${windowId} ("${windowInfo.title}") to focused space ${focusedSpaceIndex}`,
      );

      await showToast({
        style: Toast.Style.Success,
        title: "Window Moved to Focused Space",
        message: `"${windowInfo.title}" moved to the currently focused space`,
      });
    } catch (error: unknown) {
      console.error("Move to focused space failed:", error);
      await showFailureToast(error, { title: "Move Failed" });
    }
  };
};

// Space Management Functions

/**
 * Create a new space on the currently focused display
 */
export const handleCreateSpace = () => {
  return async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: "Creating New Space...",
    });

    try {
      // Get the currently focused display
      const displayResult = await execFilePromise(YABAI, ["-m", "query", "--displays", "--display"], {
        env: ENV,
      });
      const currentDisplay = parseYabaiDisplay(outputString(displayResult.stdout));

      const newSpace = await createSpaceOnDisplay(currentDisplay.index);
      console.log(`Created new space ${newSpace.index} on display ${currentDisplay.index}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Space Created",
        message: `New space ${newSpace.index} created on Display ${currentDisplay.index}`,
      });
    } catch (error: unknown) {
      console.error("Create space failed:", error);
      await showFailureToast(error, { title: "Failed to Create Space" });
    }
  };
};

async function focusAdjacentSpace(direction: "next" | "previous"): Promise<void> {
  const currentResult = await execFilePromise(YABAI, ["-m", "query", "--spaces", "--space"], {
    env: ENV,
    encoding: "utf8",
  });
  const current = parseYabaiSpace(outputString(currentResult.stdout));
  const spaces = await querySpacesOnDisplay(current.display);
  const target = getAdjacentSpace(spaces, current.index, current.display, direction);
  if (target === undefined || target === current.index) return;
  await execFilePromise(YABAI, ["-m", "space", "--focus", String(target)], { env: ENV, encoding: "utf8" });
}

/** Focus the next space on the current display, with local wraparound. */
export const handleFocusNextSpace = () => {
  return async () => {
    try {
      await focusAdjacentSpace("next");
    } catch (error: unknown) {
      await showFailureToast(error, { title: "Focus Next Space Failed" });
    }
  };
};

/** Focus the previous space on the current display, with local wraparound. */
export const handleFocusPreviousSpace = () => {
  return async () => {
    try {
      await focusAdjacentSpace("previous");
    } catch (error: unknown) {
      await showFailureToast(error, { title: "Focus Previous Space Failed" });
    }
  };
};

// ==================== Browser Tab Handlers ====================

import { BrowserTab } from "./models";
import { browserTabManager } from "./utils/browserTabManager";
import { isAppleScriptPermissionError } from "./utils/appleScriptBridge";

/**
 * Focus a specific browser tab
 * @param tab - The browser tab to focus
 * @param onFocused - Optional callback after successful focus
 */
export const handleFocusBrowserTab = (tab: BrowserTab, onFocused?: () => void) => {
  return async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: `Switching to ${tab.browser}...`,
    });

    try {
      await browserTabManager.focusTab(tab);

      await showToast({
        style: Toast.Style.Success,
        title: "Tab Focused",
        message: `${tab.title.slice(0, 40)}${tab.title.length > 40 ? "..." : ""}`,
      });

      onFocused?.();
    } catch (error: unknown) {
      console.error("Focus browser tab failed:", error);

      if (isAppleScriptPermissionError(error)) {
        await showFailureToast(new Error(`Grant Raycast automation access to ${tab.browser} in System Preferences`), {
          title: "Permission Required",
        });
      } else {
        await showFailureToast(error, { title: "Failed to Focus Tab" });
      }
    }
  };
};

/**
 * Close a browser tab
 * @param tab - The browser tab to close
 * @param onClosed - Optional callback after successful close
 */
export const handleCloseBrowserTab = (tab: BrowserTab, onClosed?: () => void) => {
  return async () => {
    await showToast({
      style: Toast.Style.Animated,
      title: "Closing Tab...",
    });

    try {
      await browserTabManager.closeTab(tab);
      await showToast({
        style: Toast.Style.Success,
        title: "Tab Closed",
        message: tab.title.slice(0, 40),
      });
      onClosed?.();
    } catch (error: unknown) {
      console.error("Close browser tab failed:", error);
      await showFailureToast(error, { title: "Failed to Close Tab" });
    }
  };
};
