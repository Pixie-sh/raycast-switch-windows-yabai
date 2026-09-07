# Yabai Window Switcher for Raycast

A powerful Raycast extension for managing windows with yabai window manager.

## Prerequisites

- [Raycast](https://raycast.com/)
- [yabai](https://github.com/koekeishiya/yabai) window manager properly installed and configured
- An executable `yabai` binary at `/opt/homebrew/bin/yabai`, `/usr/local/bin/yabai`, or on `PATH` (a custom executable path can be set in extension preferences)

The extension invokes `yabai`, `open`, and `osascript` directly with argument arrays. It does not require `jq` or `xargs`.

## Features

This extension provides a streamlined interface for managing your windows using yabai within Raycast.

### Window Management

- **Switch to Window** (Enter): Focus on the selected window
- **Open in New Space** (⌥Enter): Create a space on the window's display and move the selected window there
- **Move to Focused Space** (⌘⇧F): Move the selected window to the currently focused space

### Browser Tab Search (NEW)

Search and switch to specific browser tabs across multiple browsers:

- **Supported Browsers:** Chrome, Safari, Vivaldi, Brave, Edge, Arc, Opera, Opera GX, and Firefox (window-level focus only)
- **Switch to Tab** (Enter): Re-query the browser, validate the tab identity, then focus its current position
- **Close Tab** (⌘⌃W): Re-query and validate before closing (not offered for Firefox)

**Spotlight-like behavior:** Browser tabs are included in normal search results, appearing after windows and apps. Just start typing to search across everything!

**`@` prefix:** Use `@` to filter to tabs only:

- `@` - Show all open tabs from running browsers
- `@github` - Find only tabs with "github" in title/URL

## Usage

1. Launch Raycast
2. Search for "Switch Windows (yabai)"
3. Use the search bar to filter windows by application name or window title
4. Select a window and use the actions in the action panel

### Display Filtering

You can filter windows by specific displays using the `#N` syntax:

- **`#3`** - Show only windows on display 3
- **`#2 chrome`** - Show Chrome windows on display 2
- **`#1 terminal`** - Show Terminal windows on display 1

**Examples:**

- Type `#2` to see all windows on display 2
- Type `#1 code` to find VS Code windows on display 1
- Type `#3 safari` to find Safari windows on display 3

**Note:** Display filters only work when placed at the beginning of your search. For example, `chrome #2` will search for "chrome #2" as regular text, not filter by display.

### Browser Tab Search

Browser tabs are searched automatically alongside windows and apps:

- **Normal search** - Results show: Windows → Apps → Browser Tabs
- **`@` prefix** - Show only browser tabs (hides windows and apps)
- **`@github`** - Filter to only tabs with "github" in title, domain, or URL

**Note:** Browser tabs are loaded when the extension opens. The extension requires Automation permission for each browser (macOS will prompt on first use).

## Setup (Optional)

### Focus Tracking for External Window Switches

By default, the extension tracks window focus only when you switch via the extension. To also track focus changes from skhd hotkeys, mouse clicks, or Mission Control, run the setup script:

```bash
# Run after yabai starts to enable focus tracking
chmod +x scripts/setup-focus-tracking.sh
./scripts/setup-focus-tracking.sh
```

This installs a small recorder at `~/.local/share/raycast-yabai/record-focus.sh` and adds a yabai signal. The signal stores timestamped yabai window JSON in `~/.local/share/raycast-yabai/focus_history.log`; the extension derives an ID/app/title fingerprint so recycled yabai IDs cannot promote unrelated windows. The installer rejects action paths containing shell metacharacters and setup detection validates the exact recorder version, marker, event, label, and action.

Yabai signals are runtime state. Re-run the setup script after restarting yabai, or invoke the script from your `yabairc` after yabai starts so the signal is registered again automatically.

**To remove focus tracking later:**

```bash
yabai -m signal --remove label=raycast_focus_tracker
```

## Notes

- Windows are sorted by either recent focus time or usage count; the Sort actions select distinct behavior
- Usage and MRU references are persisted with stable app/title fingerprints
- Fresh yabai window snapshots are cached in memory for 2 seconds; stale fallback is capped at 30 seconds
- The persisted window snapshot is used only for 10 seconds while a fresh query starts
- Browser tabs are cached in memory for 30 seconds and persisted for up to 5 minutes for initial display; every focus/close action revalidates against live browser data
- Manual **Refresh Windows & Apps** invalidates the yabai cache and reloads both windows and installed applications

## Troubleshooting

### Window Issues

- Ensure yabai is running (`yabai --check-sa`)
- Verify yabai permissions are properly set up
- Check that yabai commands work from terminal

### Browser Tab Issues

- **"Permission Required" error:** Grant Raycast Automation access in System Preferences → Security & Privacy → Privacy → Automation
- **No tabs showing:** Make sure the browser is running and has at least one window open
- **Firefox tabs not showing:** Firefox has limited AppleScript support - only window titles are available, not individual tabs
- **Slow tab loading:** Live tab queries can take several seconds because browsers handle Apple Events serially. Use ⌘⇧T to force a refresh; a persisted snapshot may be shown while it runs.

### Focus Tracking Issues

- **Windows not sorted by recent focus:** Run the setup script to enable yabai signal tracking
- **Setup script fails:** Ensure yabai is installed and running
- **Check if signal is active:** Run `yabai -m signal --list | grep raycast_focus_tracker`
