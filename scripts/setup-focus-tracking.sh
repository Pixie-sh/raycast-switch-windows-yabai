#!/bin/bash
#
# Setup Focus Tracking for Raycast Switch Windows Extension
# This script configures yabai to track window focus events
#
# Run this script once to enable accurate "recently used" sorting
# that works with skhd, mouse clicks, and Mission Control
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SIGNAL_LABEL="raycast_focus_tracker"
HISTORY_DIR="$HOME/.local/share/raycast-yabai"
HISTORY_FILE="$HISTORY_DIR/focus_history.log"

echo "=========================================="
echo "  Raycast Window Switcher - Focus Tracking Setup"
echo "=========================================="
echo ""

# Check if yabai is installed
if ! command -v yabai &> /dev/null; then
    echo -e "${RED}Error: yabai is not installed or not in PATH${NC}"
    echo "Please install yabai first: https://github.com/koekeishiya/yabai"
    exit 1
fi

# Check if yabai is running
if ! pgrep -x yabai > /dev/null; then
    echo -e "${YELLOW}Warning: yabai is not currently running${NC}"
    echo "The signal will be registered but won't work until yabai starts"
fi

# Create the history directory if it doesn't exist
echo "Creating history directory: $HISTORY_DIR"
mkdir -p "$HISTORY_DIR"

# Remove existing signal if present (to allow re-running this script)
echo "Checking for existing signal..."
if yabai -m signal --list 2>/dev/null | grep -q "$SIGNAL_LABEL"; then
    echo "Removing existing signal with label: $SIGNAL_LABEL"
    yabai -m signal --remove label="$SIGNAL_LABEL" 2>/dev/null || true
fi

# Add the focus tracking signal
echo "Adding focus tracking signal..."
yabai -m signal --add \
    event=window_focused \
    label="$SIGNAL_LABEL" \
    action="echo \"\$(date +%s):\$YABAI_WINDOW_ID\" >> $HISTORY_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Focus tracking successfully configured!${NC}"
    echo ""
    echo "Details:"
    echo "  - Signal label: $SIGNAL_LABEL"
    echo "  - History file: $HISTORY_FILE"
    echo ""
    echo "The extension will now track window focus changes from:"
    echo "  - skhd hotkeys"
    echo "  - Mouse clicks"
    echo "  - Mission Control"
    echo "  - Any other focus method"
    echo ""
    
    # Verify the signal was added
    echo "Verifying installation..."
    if yabai -m signal --list 2>/dev/null | grep -q "$SIGNAL_LABEL"; then
        echo -e "${GREEN}✓ Signal verified and active${NC}"
    else
        echo -e "${YELLOW}Warning: Could not verify signal installation${NC}"
    fi
else
    echo ""
    echo -e "${RED}✗ Failed to add focus tracking signal${NC}"
    echo "Please check yabai configuration and try again"
    exit 1
fi

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "To remove focus tracking later, run:"
echo "  yabai -m signal --remove label=$SIGNAL_LABEL"
echo ""
