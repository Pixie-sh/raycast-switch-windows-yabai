/**
 * Raycast Yabai Extension
 *
 * This extension provides a set of actions for managing windows using yabai window manager.
 *
 * Main Features:
 * 1. List and search all windows and applications
 * 2. Switch to a specific window
 * 3. Aggregate windows of the same application to a space
 * 4. Close windows and empty spaces
 * 5. Disperse windows across spaces on a display
 * 6. Move a specific window to another display
 *
 * The extension uses yabai commands to manage windows and spaces. It provides a user-friendly
 * interface for interacting with yabai through Raycast.
 *
 * Usage:
 * - Use the search bar to find windows or applications
 * - Select a window to see available actions
 * - Use keyboard shortcuts for quick access to actions
 *
 * Display Actions:
 * - "Move to Display #X": Moves the selected window to the specified display
 */

import React from "react";
import { Action, ActionPanel, Keyboard, Icon } from "@raycast/api";
import { useExec } from "@raycast/utils";
import {
  handleMoveWindowToDisplay,
  getAvailableDisplays,
  handleInteractiveMoveToDisplay,
  handleMoveToFocusedDisplay,
  handleCreateSpace,
  handleFocusNextSpace,
  handleFocusPreviousSpace,
} from "./handlers";
import { ENV, YABAI, DisplayInfo } from "./models";
import { parseYabaiDisplays } from "./utils/runtimeData";
import KeyEquivalent = Keyboard.KeyEquivalent;

interface Display {
  id: number;
  uuid: string;
  index: number;
  label: string;
  frame: { x: number; y: number; w: number; h: number };
  spaces: number[];
  "has-focus": boolean;
}

interface MoveWindowToDisplayActionsProps {
  windowId: number;
  windowApp: string;
  windowTitle: string;
  currentDisplay?: number;
}

export function MoveWindowToDisplayActions({
  windowId,
  windowApp,
  windowTitle,
  currentDisplay,
}: MoveWindowToDisplayActionsProps) {
  const {
    isLoading,
    data: displays,
    error,
  } = useExec<Display[]>(YABAI, ["-m", "query", "--displays"], {
    env: ENV,
    parseOutput: ({ stdout }) => parseYabaiDisplays(stdout) as Display[],
    keepPreviousData: false,
  });

  if (isLoading) return null;
  if (error) return null;

  if (!displays || displays.length <= 1) {
    return <Action title="Move to Another Display (Only 1 Available)" onAction={() => {}} />;
  }

  return (
    <>
      {displays
        ?.filter((display) => display.index !== currentDisplay)
        .map((display) => (
          <Action
            key={display.id}
            title={`Move to Display #${display.index}`}
            onAction={handleMoveWindowToDisplay(windowId, windowApp, windowTitle, String(display.index))}
            shortcut={{ modifiers: ["cmd", "ctrl"], key: display.index.toString() as KeyEquivalent }}
          />
        ))}
    </>
  );
}

interface InteractiveMoveToDisplayActionProps {
  windowId: number;
  windowApp: string;
  windowTitle: string;
  currentDisplay?: number;
}

/**
 * Interactive component that allows users to select a display to move a window to
 * Uses a submenu to show all available displays dynamically
 */
export function InteractiveMoveToDisplayAction({
  windowId,
  windowApp,
  windowTitle,
  currentDisplay,
}: InteractiveMoveToDisplayActionProps) {
  const [displays, setDisplays] = React.useState<DisplayInfo[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadDisplays = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setDisplays(await getAvailableDisplays());
    } catch (err) {
      console.error("Failed to load displays:", err);
      setError(err instanceof Error ? err.message : "Failed to load displays");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDisplays();
  }, [loadDisplays]);

  if (error) {
    return <Action icon={Icon.ExclamationMark} title={`Retry Loading Displays (${error})`} onAction={loadDisplays} />;
  }

  if (isLoading && displays.length === 0) {
    return <Action icon={Icon.Clock} title="Loading Displays…" onAction={loadDisplays} />;
  }

  const targets = displays.filter((display) => display.index !== currentDisplay);
  if (targets.length === 0) {
    return <Action icon={Icon.Desktop} title="Move to Display (No Other Display Available)" onAction={loadDisplays} />;
  }

  return (
    <ActionPanel.Submenu
      icon={Icon.Desktop}
      title="Move to Display"
      shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
      onOpen={loadDisplays}
    >
      {targets.map((display) => (
        <Action
          key={display.index}
          icon={Icon.Circle}
          title={`Display ${display.index} (${display.dimensions})`}
          onAction={handleInteractiveMoveToDisplay(windowId, windowApp, windowTitle, display.index)}
        />
      ))}
    </ActionPanel.Submenu>
  );
}

interface MoveToFocusedDisplayActionProps {
  windowId: number;
  windowApp: string;
  windowTitle: string;
}

/**
 * Quick action to move window to the currently focused space
 */
export function MoveToFocusedDisplayAction({ windowId, windowApp, windowTitle }: MoveToFocusedDisplayActionProps) {
  return (
    <Action
      icon={Icon.Monitor}
      title="Move to Focused Space"
      onAction={handleMoveToFocusedDisplay(windowId, windowApp, windowTitle)}
      shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
    />
  );
}

/**
 * Space management actions component
 * Provides actions to create, destroy, and navigate spaces
 */
export function SpaceManagementActions() {
  return (
    <>
      <Action
        icon={Icon.Plus}
        title="Create New Space"
        onAction={handleCreateSpace()}
        shortcut={{ modifiers: ["cmd", "ctrl"], key: "n" }}
      />

      <Action
        icon={Icon.ArrowRight}
        title="Focus Next Space"
        onAction={handleFocusNextSpace()}
        shortcut={{ modifiers: ["ctrl"], key: "arrowRight" }}
      />
      <Action
        icon={Icon.ArrowLeft}
        title="Focus Previous Space"
        onAction={handleFocusPreviousSpace()}
        shortcut={{ modifiers: ["ctrl"], key: "arrowLeft" }}
      />
    </>
  );
}
