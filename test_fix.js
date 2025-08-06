// Test script to verify the fix for the "sort by previous" bug
const SortMethod = {
  USAGE: "usage",
  RECENTLY_USED: "recently_used",
};

// Mock data representing windows
const windows = [
  { id: 1, app: "Chrome", title: "Tab 1" },
  { id: 2, app: "VSCode", title: "File 1" },
  { id: 3, app: "Terminal", title: "Terminal" },
  { id: 4, app: "Finder", title: "Desktop" },
];

// Simulate the fixed sorting logic from switch-windows-yabai.tsx
function sortWindowsFixed(windows, usageTimes, sortMethod) {
  const windowsCopy = [...windows];
  
  if (sortMethod === SortMethod.RECENTLY_USED) {
    // Sort by recently used using usage times instead of focus history
    // Get the two most recently used windows (by usage timestamp)
    const recentlyUsedIds = Object.entries(usageTimes)
      .sort(([, timeA], [, timeB]) => timeB - timeA)
      .slice(0, 2)
      .map(([id]) => parseInt(id));

    // Find the corresponding windows
    const previousWindow = recentlyUsedIds[1] ? windowsCopy.find((w) => w.id === recentlyUsedIds[1]) : null; // second most recent
    const currentWindow = recentlyUsedIds[0] ? windowsCopy.find((w) => w.id === recentlyUsedIds[0]) : null;  // most recent

    return windowsCopy.sort((a, b) => {
      // Previous window (second most recently used) comes first
      if (previousWindow && a.id === previousWindow.id) return -1;
      if (previousWindow && b.id === previousWindow.id) return 1;

      // Current window (most recently used) comes second
      if (currentWindow && a.id === currentWindow.id) return -1;
      if (currentWindow && b.id === currentWindow.id) return 1;

      // For the rest (third position onwards), sort by usage time (most recent first)
      const timeA = usageTimes[a.id] || 0;
      const timeB = usageTimes[b.id] || 0;
      return timeB - timeA;
    });
  }
  
  return windowsCopy;
}

// Test scenario 1: Normal case - user switched between windows
console.log("=== Test Scenario 1: Normal switching behavior ===");
const usageTimes1 = {
  1: 1000, // oldest
  2: 2000, // second oldest  
  3: 4000, // most recent (current window)
  4: 3000, // second most recent (previous window)
};

console.log("Usage times:", usageTimes1);
const sorted1 = sortWindowsFixed(windows, usageTimes1, SortMethod.RECENTLY_USED);
console.log("Sorted windows:");
sorted1.forEach((win, index) => {
  console.log(`${index + 1}. ${win.app} (ID: ${win.id}) - Usage time: ${usageTimes1[win.id]}`);
});
console.log("✓ Expected: Finder first (previous), Terminal second (current)\n");

// Test scenario 2: Bug scenario - user didn't switch, reopened extension
console.log("=== Test Scenario 2: No switching, extension reopened ===");
const usageTimes2 = {
  1: 1000, // oldest
  2: 2000, // second oldest
  3: 3000, // previous window (was current before)
  4: 4000, // current window (same as before, but now most recent due to reopen)
};

console.log("Usage times:", usageTimes2);
const sorted2 = sortWindowsFixed(windows, usageTimes2, SortMethod.RECENTLY_USED);
console.log("Sorted windows:");
sorted2.forEach((win, index) => {
  console.log(`${index + 1}. ${win.app} (ID: ${win.id}) - Usage time: ${usageTimes2[win.id]}`);
});
console.log("✓ Expected: Terminal first (previous), Finder second (current)\n");

// Test scenario 3: Edge case - only one window has usage time
console.log("=== Test Scenario 3: Edge case - minimal usage data ===");
const usageTimes3 = {
  3: 1000, // only one window has usage time
};

console.log("Usage times:", usageTimes3);
const sorted3 = sortWindowsFixed(windows, usageTimes3, SortMethod.RECENTLY_USED);
console.log("Sorted windows:");
sorted3.forEach((win, index) => {
  console.log(`${index + 1}. ${win.app} (ID: ${win.id}) - Usage time: ${usageTimes3[win.id] || 0}`);
});
console.log("✓ Expected: Terminal first (only used window), others follow by usage time (0)\n");