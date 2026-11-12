export const FOCUS_RECORDER_CONTENT = `#!/bin/bash
# raycast-yabai-focus-recorder-v2
set -u
umask 077
YABAI_BIN=$1
HISTORY_FILE=$2
window_json=$("$YABAI_BIN" -m query --windows --window "$YABAI_WINDOW_ID") || exit 0
/bin/chmod 600 "$HISTORY_FILE" || exit 0
printf '%s\\t%s\\n' "$(/bin/date +%s)" "$window_json" >>"$HISTORY_FILE"
/bin/chmod 600 "$HISTORY_FILE"
`;

export interface FocusTrackingSignal {
  event?: unknown;
  label?: unknown;
  action?: unknown;
}

export interface FocusTrackingSetupState {
  historyFileExists: boolean;
  recorderFileExists: boolean;
  formatMarker: string | null;
  recorderContent: string | null;
  expectedSignalAction: string;
  signals: FocusTrackingSignal[];
}

export function isCurrentFocusTrackingSetup(state: FocusTrackingSetupState): boolean {
  return (
    state.historyFileExists &&
    state.recorderFileExists &&
    state.formatMarker === "2\n" &&
    state.recorderContent === FOCUS_RECORDER_CONTENT &&
    state.signals.some(
      (signal) =>
        signal.event === "window_focused" &&
        signal.label === "raycast_focus_tracker" &&
        signal.action === state.expectedSignalAction,
    )
  );
}
