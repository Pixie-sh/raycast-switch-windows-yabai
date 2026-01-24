# Focus History & Window Sorting

## Overview

This document explains how window focus history is tracked and used for sorting windows in the "recently used" order, enabling Alt+Tab-like behavior even when focus changes happen externally (via skhd, mouse, or other means).

## Architecture

### Data Sources

1. **Extension Usage Times** (`usageTimes` state)
   - Stored in Raycast LocalStorage
   - Updated when user switches windows via the extension
   - Timestamps in milliseconds

2. **Yabai Focus History** (`~/.local/share/raycast-yabai/focus_history.log`)
   - Written by yabai signal on `window_focused` event
   - Captures ALL focus changes (skhd, mouse, etc.)
   - Format: `timestamp:windowId` (timestamp in seconds)

3. **Merged Focus Times** (`mergedFocusTimes` state)
   - Combines both sources, preferring the more recent timestamp
   - Enables accurate sorting regardless of how focus changed

### Key Components

#### `focusHistoryManager.ts`

Singleton that manages reading from the yabai focus log:

```typescript
// Get focus times for windows
const times = await focusHistoryManager.getFocusTimes(windowIds);

// Record a focus event (supplements yabai log)
await focusHistoryManager.recordFocus(windowId);

// Invalidate cache to force re-read
focusHistoryManager.invalidateCache();
```

#### `getMergedFocusTimes()`

Merges extension usage with yabai history:

```typescript
export async function getMergedFocusTimes(
  extensionUsageTimes: Record<string, number>,
  windowIds: number[],
): Promise<Record<number, number>> {
  const yabaiFocusTimes = await focusHistoryManager.getFocusTimes(windowIds);
  const merged: Record<number, number> = {};

  for (const windowId of windowIds) {
    const yabaiTime = yabaiFocusTimes.get(windowId) || 0;
    const extensionTime = extensionUsageTimes[windowId] || 0;
    // yabai times are in seconds, extension times are in milliseconds
    const yabaiTimeMs = yabaiTime * 1000;
    merged[windowId] = Math.max(yabaiTimeMs, extensionTime);
  }

  return merged;
}
```

## Critical Race Condition: Async Loading

### The Problem

When the extension launches (especially via skhd shortcut):

1. Component mounts with empty `mergedFocusTimes = {}`
2. Windows load from cache immediately
3. `getMergedFocusTimes()` is called asynchronously
4. **First render happens BEFORE merged times are ready**
5. Sorting uses fallback (empty) → incorrect order

### The Solution

Track when merged focus times are ready and delay rendering:

```typescript
const [mergedFocusTimes, setMergedFocusTimes] = useState<Record<number, number>>({});
const [isMergedFocusTimesReady, setIsMergedFocusTimesReady] = useState(false);

// In the useEffect that loads merged times:
useEffect(() => {
  if (windows.length === 0) return;

  focusHistoryManager.invalidateCache();
  const windowIds = windows.map((w) => w.id);
  
  getMergedFocusTimes(usageTimes, windowIds).then((merged) => {
    setMergedFocusTimes(merged);
    setIsMergedFocusTimesReady(true);  // Mark as ready
  });
}, [windows, usageTimes, lastRefreshTime]);

// In the List component, show loading until ready:
<List
  isLoading={isLoading || !isMergedFocusTimesReady}
  // ...
>
```

This ensures the list only renders with correct sorting after focus times are loaded.

## Yabai Signal Setup

To capture external focus changes, a yabai signal must be installed:

```bash
# Add to yabairc
yabai -m signal --add event=window_focused action='echo "$(date +%s):$YABAI_WINDOW_ID" >> ~/.local/share/raycast-yabai/focus_history.log'
```

The extension checks if this file exists to determine if focus tracking is set up.

## Sorting Logic

Windows are sorted in `sortedWindows` useMemo:

```typescript
const sortedWindows = useMemo(() => {
  return [...filteredWindows].sort((a, b) => {
    // 1. Currently focused window always first
    const aFocused = a["has-focus"] || a.focused;
    const bFocused = b["has-focus"] || b.focused;
    if (aFocused && !bFocused) return -1;
    if (!aFocused && bFocused) return 1;

    // 2. Sort by merged focus times (most recent first)
    const timeA = mergedFocusTimes[a.id] || usageTimes[a.id] || 0;
    const timeB = mergedFocusTimes[b.id] || usageTimes[b.id] || 0;
    return timeB - timeA;
  });
}, [filteredWindows, mergedFocusTimes, usageTimes]);
```

## Alt+Tab Behavior

The second window in the sorted list is pre-selected for quick Alt+Tab switching:

```typescript
const selectedWindow = useMemo(() => {
  return sortedWindows.length > 1 ? sortedWindows[1] : sortedWindows[0];
}, [sortedWindows]);

// In List:
selectedItemId={selectedWindow ? `window-${selectedWindow.id}` : undefined}
```

## Debugging

Enable debug logging to trace sorting issues:

```typescript
// In sortedWindows useMemo:
if (sorted.length > 0 && isMergedFocusTimesReady) {
  console.log(
    "Sorted windows order:",
    sorted.slice(0, 5).map((w) => `${w.id}:${w.app}(${mergedFocusTimes[w.id] || 0})`),
  );
}

// In getMergedFocusTimes effect:
console.log("Merged focus times ready:", JSON.stringify(merged));
```

Check the focus history log:
```bash
tail -20 ~/.local/share/raycast-yabai/focus_history.log
```

## Common Issues

1. **"Focus changed from window null to X"** - LocalStorage `focusHistory` not loaded before refresh. This is cosmetic; the important thing is `mergedFocusTimes` loading correctly.

2. **Wrong window selected on launch** - `isMergedFocusTimesReady` not being checked, causing render before async load completes.

3. **Focus history file doesn't exist** - Yabai signal not installed. Extension shows "Setup Focus Tracking" action.

4. **Timestamps appear wrong** - Remember yabai log uses seconds, extension uses milliseconds. The merge function handles conversion.
