import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceFocusState,
  getCycledIndex,
  getCycleOriginForSelection,
  getWindowSetKey,
  hydrateWindowState,
  migrateFocusState,
  migrateLegacyUsage,
  parseFocusState,
  parseUsageStorage,
  recordWindowUsage,
  resolveCountdownTarget,
  resolveFocusReference,
  resolveSelectedWindow,
  resolveVisibleSelection,
  shouldSyncFocusHistory,
  sortWindows,
} from "../src/utils/windowState.ts";

test("cycling advances independently of a retained controlled selection", () => {
  assert.equal(getCycledIndex(0, 3, "next"), 1);
  assert.equal(getCycledIndex(0, 3, "previous"), 2);
  assert.equal(getCycledIndex(2, 3, "next"), 0);
});

test("manual selection and reordered lists synchronize the cycling origin", () => {
  assert.equal(getCycleOriginForSelection("window-2", ["window-3", "window-2", "window-1"], 0), 1);
  assert.equal(getCycleOriginForSelection("app-Mail", ["window-3", "window-2"], 1), 1);
});

test("re-focusing current window preserves the actual previous reference", () => {
  const current = { id: 2, fingerprint: "code\u001fproject" };
  const previous = { id: 1, fingerprint: "mail\u001finbox" };
  assert.deepEqual(advanceFocusState({ current, previous }, current), { current, previous });
});

test("countdown requires its captured id, app, title, and controlled selection", () => {
  const captured = { id: 2, fingerprint: "code\u001fproject" };
  const windows = [{ id: 2, app: "Code", title: "Project", display: 1, space: 1 }];
  assert.equal(resolveCountdownTarget(captured, "window-2", windows)?.id, 2);
  assert.equal(resolveCountdownTarget(captured, "window-1", windows), undefined);
  assert.equal(resolveCountdownTarget(captured, "window-2", [{ ...windows[0], title: "Replacement" }]), undefined);
});

test("LocalStorage hydration fails closed and always resolves conservative defaults", async () => {
  const result = await hydrateWindowState(async () => {
    throw new Error("storage denied");
  });
  assert.deepEqual(result.usageTimes, {});
  assert.deepEqual(result.focusHistory, { current: null, previous: null });
  assert.match(result.error?.message ?? "", /storage denied/);
});

test("focus history sync waits for both hydration and fresh yabai data", () => {
  assert.equal(shouldSyncFocusHistory(false, true), false);
  assert.equal(shouldSyncFocusHistory(true, false), false);
  assert.equal(shouldSyncFocusHistory(true, true), true);
});

test("legacy usage and focus state remain inert because they lack title identity", () => {
  const windows = [
    { id: 7, app: "Code", title: "Project", display: 1, space: 1 },
    { id: 8, app: "Mail", title: "Inbox", display: 1, space: 1 },
  ];
  const legacyUsage = parseUsageStorage('{"7":1234}');
  assert.deepEqual(migrateLegacyUsage(legacyUsage, windows), {
    "legacy-id:7": { count: 1, lastUsed: 1234 },
  });

  const legacyFocus = parseFocusState('{"current":7,"currentApp":"Code","previous":8,"previousApp":"Mail"}');
  assert.deepEqual(migrateFocusState(legacyFocus, windows), legacyFocus);
});

test("unresolved legacy focus references are preserved conservatively", () => {
  const legacyFocus = parseFocusState('{"current":7,"currentApp":"Code","previous":8,"previousApp":"Mail"}');
  const migrated = migrateFocusState(legacyFocus, [
    { id: 9, app: "Code", title: "One", display: 1, space: 1 },
    { id: 10, app: "Code", title: "Two", display: 1, space: 2 },
  ]);
  assert.deepEqual(migrated, legacyFocus);
});

test("user selection survives rerenders only while it remains visible", () => {
  assert.equal(resolveVisibleSelection("window-2", ["window-1", "window-2"], "window-1"), "window-2");
  assert.equal(resolveVisibleSelection("window-2", ["window-1"], "window-1"), "window-1");
  assert.equal(resolveVisibleSelection("stale", [], "stale"), undefined);
});

test("countdown target resolves from the same controlled window selection", () => {
  const windows = [
    { id: 1, app: "A", title: "one", display: 1, space: 1 },
    { id: 2, app: "B", title: "two", display: 1, space: 1 },
  ];
  assert.equal(resolveSelectedWindow("window-2", windows)?.id, 2);
  assert.equal(resolveSelectedWindow("tab-Safari-1-1", windows), undefined);
});

test("display search cache key changes when same-count window objects change", () => {
  const first = [{ id: 1, app: "Code", title: "Old", display: 2, space: 4 }];
  const second = [{ id: 1, app: "Code", title: "New", display: 2, space: 5 }];
  assert.notEqual(getWindowSetKey(first), getWindowSetKey(second));
});

test("recent and usage sorting are distinct", () => {
  const windows = [
    { id: 1, app: "A", title: "one", display: 1, space: 1 },
    { id: 2, app: "B", title: "two", display: 1, space: 1 },
  ];
  const usage = {
    "window-id:1\u001fa\u001fone": { count: 10, lastUsed: 100 },
    "window-id:2\u001fb\u001ftwo": { count: 1, lastUsed: 200 },
  };

  assert.deepEqual(
    sortWindows(windows, "recently_used", usage, { 1: 100, 2: 200 }).map((w) => w.id),
    [2, 1],
  );
  assert.deepEqual(
    sortWindows(windows, "usage", usage, { 1: 100, 2: 200 }).map((w) => w.id),
    [1, 2],
  );
});

test("fingerprint-only legacy usage does not rank any live window", () => {
  const windows = [
    { id: 1, app: "Terminal", title: "shell", display: 1, space: 1 },
    { id: 2, app: "Terminal", title: "shell", display: 1, space: 2 },
    { id: 3, app: "Mail", title: "Inbox", display: 1, space: 3 },
  ];
  const usage = {
    "terminal\u001fshell": { count: 10, lastUsed: 300 },
    "mail\u001finbox": { count: 1, lastUsed: 100 },
  };
  assert.deepEqual(
    sortWindows(windows, "usage", usage, {}).map((window) => window.id),
    [1, 2, 3],
  );
});

test("MRU rejects a same-app recycled id when its title fingerprint changes", () => {
  const original = { id: 2, app: "Terminal", title: "shell", display: 1, space: 2 };
  const usage = recordWindowUsage({}, original, 300);
  const windows = [
    { id: 1, app: "Terminal", title: "shell", display: 1, space: 1 },
    { ...original, title: "shell — running tests" },
  ];
  assert.deepEqual(
    sortWindows(windows, "usage", usage, {}).map((window) => window.id),
    [1, 2],
  );
});

test("focus references reject recycled IDs even when another id has the old fingerprint", () => {
  const windows = [
    { id: 7, app: "Mail", title: "Inbox", display: 1, space: 1 },
    { id: 9, app: "Code", title: "Project", display: 1, space: 1 },
  ];
  const stored = { id: 7, fingerprint: "code\u001fproject" };
  assert.equal(resolveFocusReference(stored, windows), undefined);
  assert.equal(resolveFocusReference({ id: 7, fingerprint: "gone\u001fwindow" }, windows), undefined);
});

test("focus references fail closed when the same id and app has a different title", () => {
  const windows = [{ id: 7, app: "Code", title: "Renamed", display: 1, space: 1 }];
  assert.equal(resolveFocusReference({ id: 7, fingerprint: "code\u001fold" }, windows), undefined);
});
