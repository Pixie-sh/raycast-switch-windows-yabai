# Yabai Window Switcher for Raycast

A powerful Raycast extension for managing windows with the [yabai](https://github.com/koekeishiya/yabai) tiling window manager. It provides fast window switching, display management, browser tab search, and an intelligent auto-select mechanism inspired by ⌘+Tab behavior.

## Prerequisites (Mandatory)

### yabai Window Manager

**yabai is required** for this extension to function. It must be installed, running, and accessible in your `PATH` before using this extension.

1. **Install yabai** — follow the official installation guide:
   - [yabai GitHub — Installation](https://github.com/koekeishiya/yabai/wiki/Installing-yabai-(latest-release))
   - Supported on macOS only.
2. **Configure the scripting addition** (recommended for full functionality):
   - [yabai GitHub — Scripting Addition](https://github.com/koekeishiya/yabai/wiki/Installing-yabai-(latest-release)#configure-scripting-addition)
3. **Verify yabai is working:**

   ```bash
   yabai --check-sa   # Check scripting addition
   yabai -m query --windows  # List windows — must return JSON
   ```

   The extension looks for yabai at `/opt/homebrew/bin/yabai` or `/usr/local/bin/yabai`, then falls back to `which yabai`.

### Other Requirements

- [Raycast](https://raycast.com/) installed on macOS
- macOS Accessibility permissions granted to Raycast (System Settings → Privacy & Security → Accessibility)

## Features

### Window Management

- **Switch to Window** (Enter): Focus on the selected window using yabai
- **Aggregate to Space** (⌘⇧M): Move the selected window to the current space
- **Close Window** (⌘⇧W): Close the selected window
- **Close Empty Spaces** (⌘⇧Q): Remove spaces that don't contain any windows

### Display Management

- **Disperse Windows for Display #N** (⌘⇧1, ⌘⇧2, etc.): Distribute windows across spaces on the specified display

### Browser Tab Search

Search and switch to specific browser tabs across multiple browsers:

- **Supported Browsers:** Chrome, Safari, Vivaldi, Brave, Edge, Arc, Firefox (limited — window titles only)
- **Switch to Tab** (Enter): Focus the selected tab in its browser window
- **Close Tab** (⌘⇧W): Close the selected browser tab

**Spotlight-like behavior:** Browser tabs are included in normal search results, appearing after windows and apps. Just start typing to search across everything.

**`@` prefix:** Use `@` to filter to tabs only:
- `@` — Show all open tabs from running browsers
- `@github` — Find only tabs with "github" in title/URL

## Extension Logic & Architecture

### Search & Ranking

The extension uses a multi-tier search strategy:

1. **Exact substring match** — fast path checking if the query appears in the window title or app name.
2. **Adjacent-swap typo tolerance** — for short queries (3–4 characters), automatically generates character-swap variants to handle common transposition typos (e.g., "crhome" matches "chrome").
3. **Fuse.js fuzzy search** — final fallback using configurable fuzzy matching for broader results.

Results are ranked by field priority (app name → window title), exact equality, field length (shorter = better), and original sort order.

### Yabai Query Caching

All yabai queries (windows, spaces, displays) are routed through a centralized `YabaiQueryManager` that:

- **De-duplicates in-flight requests** — concurrent calls share the same promise.
- **Caches results** with a 2-second TTL to prevent redundant process spawning.
- **Retries on incomplete JSON** — if yabai produces truncated output, the manager retries once with a 60 ms backoff.
- **Falls back to stale data** on error, so the UI never goes blank.

### Focus History & Window Sorting

Windows are sorted by most recently focused for quick access. The extension merges two data sources:

- **Extension-internal usage times** — recorded in Raycast `LocalStorage` whenever you switch via the extension.
- **Yabai signal log** — an optional file-based log (`~/.local/share/raycast-yabai/focus_history.log`) written by a yabai signal that captures *all* focus changes (mouse clicks, skhd hotkeys, Mission Control). The log is automatically rotated when it exceeds 1 000 entries.

The most recent timestamp from either source wins for each window, ensuring accurate ordering regardless of how focus was changed.

### Exponential Backoff for Automatic Selection

The extension includes an **auto-select countdown** that mimics ⌘+Tab "release-to-switch" behavior. When you cycle through windows with Tab/Shift+Tab, a countdown timer starts that will automatically switch to the highlighted window.

**How it works:**

The delay before auto-selecting increases exponentially with each additional Tab press, following the formula:

```
delay = min(BASE × BACKOFF ^ (presses - 1), MAX)
```

| Constant | Value | Description |
|---|---|---|
| `AUTO_SELECT_BASE` | 1 050 ms | Starting delay after the first Tab press |
| `AUTO_SELECT_BACKOFF` | 1.4 | Exponential growth factor |
| `AUTO_SELECT_MAX` | 3 000 ms | Maximum delay cap |
| `AUTO_SELECT_GIVE_UP` | 6 presses | After this many presses, auto-select is cancelled entirely |

**Example delay progression:**

| Tab presses | Delay |
|---|---|
| 1 | 1 050 ms |
| 2 | 1 470 ms |
| 3 | 2 058 ms |
| 4 | 2 881 ms |
| 5 | 3 000 ms (capped) |
| 6+ | Auto-select disabled |

**Cancellation:** The countdown is permanently cancelled when the user:
- Types any text in the search bar (switches to search mode).
- Presses Tab 6 or more times (the user is browsing, not quick-switching).

A visual countdown is displayed in the section subtitle (e.g., "auto-switching in 1.8s") so the user always knows what will happen.

### Performance Monitoring

The extension includes a built-in performance monitor that tracks operation timings (yabai queries, search, cache hits) with rolling percentile statistics. In development mode, it alerts on operations exceeding configurable thresholds.

## Usage

1. Launch Raycast
2. Search for "Switch Windows (yabai)"
3. Use the search bar to filter windows by application name or window title
4. Select a window and press Enter, or let auto-select switch for you

### Display Filtering

Filter windows by specific displays using the `#N` syntax at the **beginning** of your search:

- `#3` — Show only windows on display 3
- `#2 chrome` — Show Chrome windows on display 2
- `#1 terminal` — Show Terminal windows on display 1

**Note:** `chrome #2` will search for "chrome #2" as regular text — the `#N` prefix must come first.

### Browser Tab Search

Browser tabs are searched automatically alongside windows and apps:

- **Normal search** — Results show: Windows → Apps → Browser Tabs
- **`@` prefix** — Show only browser tabs (hides windows and apps)
- **`@github`** — Filter to only tabs with "github" in title, domain, or URL

**Note:** The extension requires macOS Automation permission for each browser (macOS will prompt on first use).

## Setup (Optional)

### Focus Tracking for External Window Switches

By default, the extension tracks window focus only when you switch via the extension itself. To also track focus changes from skhd hotkeys, mouse clicks, or Mission Control, run the setup script:

```bash
# Run once to enable focus tracking
chmod +x scripts/setup-focus-tracking.sh
./scripts/setup-focus-tracking.sh
```

This installs a yabai signal that logs every `window_focused` event to `~/.local/share/raycast-yabai/focus_history.log`.

**To remove focus tracking later:**
```bash
yabai -m signal --remove label=raycast_focus_tracker
```

## Notes

- Windows are sorted by most recently used (merged from extension storage and yabai signal history)
- Browser tabs are cached for 5 seconds to improve performance
- Yabai query results are cached for 2 seconds and de-duplicated across concurrent calls
- The extension auto-detects yabai at `/opt/homebrew/bin/yabai`, `/usr/local/bin/yabai`, or via `$PATH`

## Troubleshooting

### yabai Issues
- **Extension won't load:** Ensure yabai is installed and running — see [yabai installation guide](https://github.com/koekeishiya/yabai/wiki/Installing-yabai-(latest-release))
- **"Command failed" errors:** Run `yabai -m query --windows` in your terminal to verify yabai is responding
- **Scripting addition errors:** Run `yabai --check-sa` and follow the [scripting addition setup](https://github.com/koekeishiya/yabai/wiki/Installing-yabai-(latest-release)#configure-scripting-addition)
- **Permissions:** Ensure yabai has Accessibility permissions in System Settings → Privacy & Security → Accessibility

### Browser Tab Issues
- **"Permission Required" error:** Grant Raycast Automation access in System Settings → Privacy & Security → Automation
- **No tabs showing:** Make sure the browser is running and has at least one window open
- **Firefox tabs not showing:** Firefox has limited AppleScript support — only window titles are available, not individual tabs
- **Slow tab loading:** Tabs are cached for 5 seconds. Use ⌘⌃R to force refresh

### Focus Tracking Issues
- **Windows not sorted by recent focus:** Run the setup script to enable yabai signal tracking
- **Setup script fails:** Ensure yabai is installed and running
- **Check if signal is active:** Run `yabai -m signal --list | grep raycast_focus_tracker`
