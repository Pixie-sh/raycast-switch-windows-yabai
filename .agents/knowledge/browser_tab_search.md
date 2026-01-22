# Browser Tab Search & Focus Tracking

Implementation patterns for browser tab integration and external focus tracking in the Raycast extension.

---

## 1. 🌐 BROWSER TAB SEARCH

### Overview

Browser tabs are searchable alongside windows and apps (Spotlight-like behavior). The `@` prefix filters to tabs only.

**Search priority:** Windows → Apps → Browser Tabs

### Supported Browsers

| Browser | Type | Tab Support |
|---------|------|-------------|
| Google Chrome | Chromium | Full |
| Vivaldi | Chromium | Full |
| Brave Browser | Chromium | Full |
| Microsoft Edge | Chromium | Full |
| Arc | Chromium | Full |
| Safari | Native | Full |
| Firefox | Gecko | Limited (window titles only) |

### AppleScript Patterns

**Chromium-based browsers (Chrome, Vivaldi, Brave, Edge, Arc):**

```applescript
tell application "Google Chrome"
  set windowCount to count of windows
  repeat with w from 1 to windowCount
    set tabCount to count of tabs of window w
    set activeIdx to active tab index of window w
    repeat with t from 1 to tabCount
      set theTab to tab t of window w
      set tabURL to URL of theTab
      set tabTitle to title of theTab
      set isActive to (t = activeIdx)
    end repeat
  end repeat
end tell
```

**Safari (different API):**

```applescript
tell application "Safari"
  set windowCount to count of windows
  repeat with w from 1 to windowCount
    set tabCount to count of tabs of window w
    set currentTab to current tab of window w
    repeat with t from 1 to tabCount
      set theTab to tab t of window w
      set tabURL to URL of theTab
      set tabTitle to name of theTab  -- Safari uses 'name' not 'title'
      set isActive to (theTab = currentTab)
    end repeat
  end repeat
end tell
```

**Focus a specific tab (Chromium):**

```applescript
tell application "Google Chrome"
  set active tab index of window 1 to 3  -- Switch to tab 3
  set index of window 1 to 1             -- Bring window to front
  activate
end tell
```

### Data Model

```typescript
interface BrowserTab {
  id: string;           // "browser-windowIndex-tabIndex"
  browser: BrowserType;
  windowIndex: number;  // 1-based
  tabIndex: number;     // 1-based
  url: string;
  title: string;
  isActive: boolean;
  domain: string;       // Extracted from URL
}

enum BrowserType {
  CHROME = "Google Chrome",
  VIVALDI = "Vivaldi",
  BRAVE = "Brave Browser",
  EDGE = "Microsoft Edge",
  ARC = "Arc",
  SAFARI = "Safari",
  FIREFOX = "Firefox",
}
```

### Implementation Files

- `src/utils/appleScriptBridge.ts` - Generic AppleScript execution
- `src/utils/browserTabManager.ts` - Tab query/cache manager
- `src/models.ts` - BrowserTab interface, BrowserType enum
- `src/handlers.ts` - handleFocusBrowserTab, handleCloseBrowserTab

### Caching Strategy

```typescript
class BrowserTabManager {
  private cache: Map<BrowserType, TabCache>;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds
  
  // Query deduplication - prevent parallel queries
  if (cacheEntry.inFlight) {
    return cacheEntry.inFlight;
  }
  
  // Return cached if fresh
  if (cacheEntry.data && now - cacheEntry.timestamp < CACHE_TTL_MS) {
    return cacheEntry.data;
  }
}
```

### Performance Optimizations

1. **Load on mount** - Tabs load when extension opens (not lazily)
2. **Parallel browser queries** - Query all running browsers simultaneously
3. **Check running browsers first** - Use yabai window list to skip closed browsers
4. **Tab limit** - Max 200 tabs per browser
5. **5-second cache TTL** - Prevent excessive AppleScript calls

### Error Handling

```typescript
// Permission errors - remember and skip future queries
if (isAppleScriptPermissionError(error)) {
  this.permissionErrors.add(browser);
  return [];
}

// Browser not running - graceful empty return
if (isBrowserNotRunning(error)) {
  return [];
}
```

---

## 2. 🎯 FOCUS TRACKING

### Overview

Track window focus changes from external sources (skhd, mouse clicks, Mission Control) using yabai signals.

### yabai Signal Setup

```bash
yabai -m signal --add \
  event=window_focused \
  label=raycast_focus_tracker \
  action='echo "$(date +%s):$YABAI_WINDOW_ID" >> ~/.local/share/raycast-yabai/focus_history.log'
```

### Log Format

```
1737500000:12345
1737500005:12346
1737500010:12347
```

Format: `unix_timestamp:window_id`

### Implementation Files

- `src/utils/focusHistoryManager.ts` - Read/parse focus log
- `scripts/setup-focus-tracking.sh` - One-time setup script

### Log Management

```typescript
const MAX_HISTORY_ENTRIES = 500;
const ROTATION_THRESHOLD = 1000;

// Rotate when > 1000 entries, keep most recent 500
if (lines.length > ROTATION_THRESHOLD) {
  const recentLines = lines.slice(-MAX_HISTORY_ENTRIES);
  await writeFile(FOCUS_HISTORY_FILE, recentLines.join("\n") + "\n");
}
```

### Integration Pattern

```typescript
// Merge extension usage times with yabai focus history
export async function getMergedFocusTimes(
  extensionUsageTimes: Record<string, number>,
  windowIds: number[]
): Promise<Record<number, number>> {
  const yabaiFocusTimes = await focusHistoryManager.getFocusTimes(windowIds);
  
  for (const windowId of windowIds) {
    const yabaiTime = yabaiFocusTimes.get(windowId) || 0;
    const extensionTime = extensionUsageTimes[windowId] || 0;
    // yabai times are seconds, extension times are milliseconds
    merged[windowId] = Math.max(yabaiTime * 1000, extensionTime);
  }
}
```

---

## 3. 🔍 SEARCH FILTER PATTERNS

### Tab Filter (@)

```typescript
function parseTabFilter(searchText: string): {
  hasTabFilter: boolean;
  remainingSearchText: string;
} {
  const trimmed = searchText.trim();
  if (trimmed.startsWith("@")) {
    return {
      hasTabFilter: true,
      remainingSearchText: trimmed.slice(1).trim(),
    };
  }
  return { hasTabFilter: false, remainingSearchText: searchText };
}
```

### Display Filter (#)

```typescript
// Already exists in utils/displayFilter.ts
const { displayNumber, remainingSearchText, hasDisplayFilter } = parseDisplayFilter(searchText);
```

### Search Behavior Matrix

| Input | Windows | Apps | Tabs |
|-------|---------|------|------|
| (empty) | ✓ All | ✓ All | ✗ Hidden |
| `code` | ✓ Filtered | ✓ Filtered | ✓ Filtered |
| `#2` | ✓ Display 2 | ✓ All | ✗ Hidden |
| `#2 code` | ✓ Display 2 + Filtered | ✓ Filtered | ✗ Hidden |
| `@` | ✗ Hidden | ✗ Hidden | ✓ All |
| `@github` | ✗ Hidden | ✗ Hidden | ✓ Filtered |

---

## 4. 🎨 UI PATTERNS

### Browser Colors

```typescript
function getBrowserColor(browser: BrowserType): string {
  switch (browser) {
    case BrowserType.CHROME: return "#4285f4";  // Google blue
    case BrowserType.SAFARI: return "#007aff";  // Apple blue
    case BrowserType.VIVALDI: return "#ef3939"; // Vivaldi red
    case BrowserType.BRAVE: return "#fb542b";   // Brave orange
    case BrowserType.EDGE: return "#0078d7";    // Microsoft blue
    case BrowserType.ARC: return "#ff4f8b";     // Arc pink
    case BrowserType.FIREFOX: return "#ff7139"; // Firefox orange
    default: return "#6b7280";
  }
}
```

### Tab List Item

```tsx
<List.Item
  key={tab.id}
  icon={{ source: getBrowserIcon(tab.browser) }}
  title={tab.title || "Untitled"}
  subtitle={tab.domain}
  accessories={[
    { tag: { value: tab.browser.split(" ")[0], color: getBrowserColor(tab.browser) } },
    ...(tab.isActive ? [{ tag: { value: "active", color: "#10b981" } }] : []),
  ]}
/>
```

---

## 5. 🚨 COMMON PITFALLS

### 1. AppleScript Quoting

```typescript
// Escape single quotes for shell execution
function escapeAppleScript(script: string): string {
  return script.replace(/'/g, "'\"'\"'");
}

// Execute with proper escaping
await execAsync(`osascript -e '${escapeAppleScript(script)}'`);
```

### 2. Browser Name Matching

```typescript
// Browser names must match exactly what yabai reports
// Use BrowserType enum values, not arbitrary strings
if (runningApps.has(BrowserType.CHROME)) { ... }
```

### 3. Tab Index vs Window Index

```typescript
// Both are 1-based in AppleScript
// Tab 1 of Window 1 = first tab in first window
set active tab index of window 1 to 3  // Correct
set active tab index of window 0 to 2  // WRONG - no window 0
```

### 4. Safari vs Chromium Differences

```typescript
// Safari: uses 'name' for tab title, 'current tab' for active
// Chromium: uses 'title' for tab title, 'active tab index' for active

// Safari
set tabTitle to name of theTab
set isActive to (theTab = current tab of window w)

// Chromium
set tabTitle to title of theTab
set isActive to (t = active tab index of window w)
```

---

## 6. 📋 QUICK REFERENCE

### Add New Browser Support

1. Add to `BrowserType` enum in `src/models.ts`
2. Add color to `getBrowserColor()` in `src/switch-windows-yabai.tsx`
3. If Chromium-based: Add to `CHROMIUM_BROWSERS` array in `browserTabManager.ts`
4. If non-Chromium: Add dedicated fetch method (like `fetchSafariTabs`)

### Test AppleScript Manually

```bash
# Test Chrome tabs
osascript -e 'tell application "Google Chrome" to get title of active tab of window 1'

# Test Safari tabs
osascript -e 'tell application "Safari" to get name of current tab of window 1'

# Check if browser is running
osascript -e 'tell application "System Events" to get name of every process whose name is "Google Chrome"'
```

### Debug Focus Tracking

```bash
# Check if signal is installed
yabai -m signal --list | grep raycast_focus_tracker

# View focus history log
tail -f ~/.local/share/raycast-yabai/focus_history.log

# Manually trigger focus event
echo "$(date +%s):12345" >> ~/.local/share/raycast-yabai/focus_history.log
```
