#!/bin/bash
# Configure durable, fingerprinted focus tracking for the extension.
set -euo pipefail
umask 077

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
SIGNAL_LABEL="raycast_focus_tracker"
HISTORY_DIR="$HOME/.local/share/raycast-yabai"
HISTORY_FILE="$HISTORY_DIR/focus_history.log"
RECORDER="$HISTORY_DIR/record-focus.sh"
FORMAT_MARKER="$HISTORY_DIR/format-v2"

printf '%s\n' "==========================================" \
  "  Raycast Window Switcher - Focus Tracking Setup" \
  "==========================================" ""

if ! command -v yabai >/dev/null 2>&1; then
  printf '%b\n' "${RED}Error: yabai is not installed or not in PATH${NC}"
  printf '%s\n' "Please install yabai first: https://github.com/koekeishiya/yabai"
  exit 1
fi
YABAI_BIN=$(command -v yabai)

if ! pgrep -x yabai >/dev/null; then
  printf '%b\n' "${YELLOW}Warning: yabai is not currently running${NC}"
fi

printf 'Creating history directory: %s\n' "$HISTORY_DIR"
mkdir -p "$HISTORY_DIR"
chmod 700 "$HISTORY_DIR"
touch "$HISTORY_FILE"
chmod 600 "$HISTORY_FILE"

# The signal invokes this fixed helper. Arguments and paths remain separate and
# the yabai JSON is stored as one tab-delimited field, so titles cannot become commands.
cat >"$RECORDER" <<'RECORDER_EOF'
#!/bin/bash
# raycast-yabai-focus-recorder-v2
set -u
umask 077
YABAI_BIN=$1
HISTORY_FILE=$2
window_json=$("$YABAI_BIN" -m query --windows --window "$YABAI_WINDOW_ID") || exit 0
/bin/chmod 600 "$HISTORY_FILE" || exit 0
printf '%s\t%s\n' "$(/bin/date +%s)" "$window_json" >>"$HISTORY_FILE"
/bin/chmod 600 "$HISTORY_FILE"
RECORDER_EOF
chmod 700 "$RECORDER"

if "$YABAI_BIN" -m signal --list 2>/dev/null | grep -Fq "$SIGNAL_LABEL"; then
  printf 'Removing existing signal with label: %s\n' "$SIGNAL_LABEL"
  "$YABAI_BIN" -m signal --remove label="$SIGNAL_LABEL" 2>/dev/null || true
fi

for action_path in "$RECORDER" "$YABAI_BIN" "$HISTORY_FILE"; do
  if [[ ! "$action_path" =~ ^[A-Za-z0-9_./-]+$ ]]; then
    printf '%b\n' "${RED}Error: focus tracking paths may only contain letters, digits, _, ., /, and -${NC}"
    exit 1
  fi
done
action="$RECORDER $YABAI_BIN $HISTORY_FILE"

printf '%s\n' "Adding focus tracking signal..."
if "$YABAI_BIN" -m signal --add event=window_focused label="$SIGNAL_LABEL" action="$action"; then
  printf '2\n' >"$FORMAT_MARKER"
  chmod 600 "$FORMAT_MARKER"
  printf '%b\n' "${GREEN}✓ Focus tracking successfully configured!${NC}"
else
  printf '%b\n' "${RED}✗ Failed to add focus tracking signal${NC}"
  printf '%s\n' "Please check yabai configuration and try again"
  exit 1
fi

printf '%s\n' "Verifying installation..."
if "$YABAI_BIN" -m signal --list 2>/dev/null | grep -Fq "$SIGNAL_LABEL"; then
  printf '%b\n' "${GREEN}✓ Signal verified and active${NC}"
else
  printf '%b\n' "${YELLOW}Warning: Could not verify signal installation${NC}"
fi

printf '\nHistory file: %s\n' "$HISTORY_FILE"
printf 'To remove focus tracking: %q -m signal --remove label=%q\n' "$YABAI_BIN" "$SIGNAL_LABEL"
