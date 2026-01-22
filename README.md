# Yabai Window Switcher for Raycast

A powerful Raycast extension for managing windows with yabai window manager.

## Prerequisites

- [Raycast](https://raycast.com/)
- [yabai](https://github.com/koekeishiya/yabai) window manager properly installed and configured
- Make sure yabai is accessible in your PATH

## Features

This extension provides a streamlined interface for managing your windows using yabai within Raycast.

### Window Management

- **Switch to Window** (Enter): Focus on the selected window
- **Aggregate to Space** (⌘⇧M): Move selected window to current space
- **Close Window** (⌘⇧W): Close the selected window
- **Close Empty Spaces** (⌘⇧Q): Remove spaces that don't contain any windows

### Display Management

- **Disperse Windows for Display #N** (⌘⇧1, ⌘⇧2, etc.): Distribute windows across spaces on the specified display

### Browser Tab Search (NEW)

Search and switch to specific browser tabs across multiple browsers:

- **Supported Browsers:** Chrome, Safari, Vivaldi, Brave, Edge, Arc, Firefox (limited)
- **Switch to Tab** (Enter): Focus the selected tab in its browser window
- **Close Tab** (⌘⇧W): Close the selected browser tab

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
# Run once to enable focus tracking
chmod +x scripts/setup-focus-tracking.sh
./scripts/setup-focus-tracking.sh
```

This adds a yabai signal that logs focus changes to `~/.local/share/raycast-yabai/focus_history.log`.

**To remove focus tracking later:**
```bash
yabai -m signal --remove label=raycast_focus_tracker
```

## Notes

- Windows are sorted by most recently used for quick access
- The extension maintains a history of your window usage across sessions
- Window switching history is persisted using Raycast's LocalStorage
- Browser tabs are cached for 5 seconds to improve performance

## Troubleshooting

### Window Issues
- Ensure yabai is running (`yabai --check-sa`)
- Verify yabai permissions are properly set up
- Check that yabai commands work from terminal

### Browser Tab Issues
- **"Permission Required" error:** Grant Raycast Automation access in System Preferences → Security & Privacy → Privacy → Automation
- **No tabs showing:** Make sure the browser is running and has at least one window open
- **Firefox tabs not showing:** Firefox has limited AppleScript support - only window titles are available, not individual tabs
- **Slow tab loading:** Tabs are cached for 5 seconds. Use ⌘⌃R to force refresh

### Focus Tracking Issues
- **Windows not sorted by recent focus:** Run the setup script to enable yabai signal tracking
- **Setup script fails:** Ensure yabai is installed and running
- **Check if signal is active:** Run `yabai -m signal --list | grep raycast_focus_tracker`
