import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getInitialDisplayedWindowItemId, makeFocusReference } from "../src/utils/windowState.ts";

// Execute the component's actual callbacks with inert adapters; no Raycast or
// yabai process is invoked. This catches wiring bugs that helper-only tests miss.
async function commandCallback(name: string, context: Record<string, unknown>) {
  const text = await readFile("src/switch-windows-yabai.tsx", "utf8");
  const source = ts.createSourceFile("command.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer, `Missing callback ${name}`);
  const output = ts.transpileModule(`const callback = ${initializer.getText(source)}; callback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(output, { useCallback: (callback: unknown) => callback, ...context });
}

function startupContext() {
  const snapshot = [
    { id: 1, app: "Mail", title: "Inbox", space: 1, "has-focus": false },
    { id: 2, app: "Code", title: "Project", space: 1, "has-focus": true },
  ];
  let selected: string | undefined;
  let settled = false;
  let queryCount = 0;
  const context = {
    initialSelectionInitializedRef: { current: false },
    selectedItemIdRef: { current: undefined as string | undefined },
    userInteractedRef: { current: false },
    focusHistoryCurrentRef: { current: null },
    isFocusHistoryLoadedRef: { current: false },
    getInitialDisplayedWindowItemId,
    makeFocusReference,
    getWindowItemId: (id: number) => `window-${id}`,
    yabaiQueryManager: { queryWindows: async () => { queryCount += 1; return snapshot; } },
    beginRefreshActivity: () => {},
    endRefreshActivity: () => {},
    updateFocusHistory: () => {},
    setUserSelectedItemId: (id: string | undefined) => { selected = id; },
    setCycleIndex: () => {},
    setWindows: () => {},
    setHasFreshWindowData: () => {},
    setIsInitialWindowQuerySettled: (value: boolean) => { settled = value; },
    setLastRefreshTime: () => {},
    LocalStorage: { setItem: async () => {} },
    runBestEffort: async (operation: () => Promise<void>) => operation(),
    IncompleteJsonError: class extends Error {},
    console: { error: () => {}, warn: () => {} },
  };
  return { context, snapshot, selection: () => selected, settled: () => settled, queries: () => queryCount };
}

test("raw refresh does not select the focused row", async () => {
  const state = startupContext();
  const refresh = await commandCallback("refreshWindows", state.context);
  await refresh();
  assert.equal(state.selection(), undefined);
  assert.equal(state.settled(), true);
  assert.equal(state.queries(), 1);
});

test("startup initialization selects the second displayed row after ordering is ready", async () => {
  const state = startupContext();
  const sortedWindows = [
    { id: 3, app: "Terminal", title: "Shell", space: 1, "has-focus": false },
    { id: 1, app: "Mail", title: "Inbox", space: 1, "has-focus": false },
    { id: 2, app: "Code", title: "Project", space: 1, "has-focus": true },
  ];
  const initialize = await commandCallback("initializeInitialWindowSelection", {
    ...state.context,
    isInitialWindowQuerySettled: true,
    isFocusHistoryLoaded: true,
    isMergedFocusTimesReady: true,
    sortedWindows,
    cycleIndexRef: { current: 0 },
  });
  initialize();
  assert.equal(state.selection(), "window-1");
  assert.equal(state.context.initialSelectionInitializedRef.current, true);
  state.context.setUserSelectedItemId("window-3");
  initialize();
  assert.equal(state.selection(), "window-3");
});

test("startup waits for ordering inputs rather than freezing cached order", async () => {
  for (const missing of ["isInitialWindowQuerySettled", "isFocusHistoryLoaded", "isMergedFocusTimesReady"]) {
    const state = startupContext();
    const initialize = await commandCallback("initializeInitialWindowSelection", {
      ...state.context,
      isInitialWindowQuerySettled: true,
      isFocusHistoryLoaded: true,
      isMergedFocusTimesReady: true,
      [missing]: false,
      sortedWindows: state.snapshot,
      cycleIndexRef: { current: 0 },
    });
    initialize();
    assert.equal(state.context.initialSelectionInitializedRef.current, false);
    assert.equal(state.selection(), undefined);
  }
});

test("ordering readiness belongs to the current window snapshot", async () => {
  const windows = startupContext().snapshot;
  assert.equal(await commandCallback("isMergedFocusTimesReady", {
    windows, mergedFocusWindows: [...windows],
  }), false);
  assert.equal(await commandCallback("isMergedFocusTimesReady", {
    windows, mergedFocusWindows: windows,
  }), true);
});

test("startup ignores cached automatic selection callbacks", async () => {
  const state = startupContext();
  const onSelection = await commandCallback("handleSelectionChange", {
    ...state.context, isInitialWindowQuerySettled: false,
  });
  onSelection("window-1");
  assert.equal(state.context.userInteractedRef.current, false);
  await (await commandCallback("refreshWindows", state.context))();
  assert.equal(state.selection(), undefined);
});

test("failed live startup releases the selection gate after initialization readiness", async () => {
  const state = startupContext();
  state.context.yabaiQueryManager.queryWindows = async () => { throw new Error("query failed"); };
  await (await commandCallback("refreshWindows", state.context))();
  assert.equal(state.settled(), true);
  const initialize = await commandCallback("initializeInitialWindowSelection", {
    ...state.context,
    isInitialWindowQuerySettled: true,
    isFocusHistoryLoaded: true,
    isMergedFocusTimesReady: true,
    sortedWindows: [],
    cycleIndexRef: { current: 0 },
  });
  initialize();
  assert.equal(state.context.initialSelectionInitializedRef.current, true);
});

test("early search and scope changes prevent startup from stealing selection", async () => {
  for (const [name, value] of [["handleSearchTextChange", "mail"], ["handleScopeChange", "tabs"]]) {
    const state = startupContext();
    await (await commandCallback(name, { ...state.context, scopeFilter: "all", setInputText: () => {}, setScopeFilter: () => {} }))(value);
    state.context.setUserSelectedItemId("user-choice");
    await (await commandCallback("refreshWindows", state.context))();
    await (await commandCallback("initializeInitialWindowSelection", {
      ...state.context, isInitialWindowQuerySettled: true, isFocusHistoryLoaded: true,
      isMergedFocusTimesReady: true, sortedWindows: state.snapshot, cycleIndexRef: { current: 0 },
    }))();
    assert.equal(state.selection(), "user-choice");
  }
});

test("the initial scope value is not mistaken for user navigation", async () => {
  const state = startupContext();
  const change = await commandCallback("handleScopeChange", { ...state.context, scopeFilter: "all", setScopeFilter: () => {} });
  change("all");
  assert.equal(state.context.userInteractedRef.current, false);
});

test("Tab cycling uses a short constant pause rather than exponential backoff", async () => {
  const command = await readFile("src/switch-windows-yabai.tsx", "utf8");
  const delay = Number(command.match(/const AUTO_SELECT_DELAY_MS = (\d+);/)?.[1]);
  assert.ok(delay > 0 && delay <= 300, `Expected a cycling pause of at most 300ms, got ${delay}`);
  assert.match(command, /const delay = AUTO_SELECT_DELAY_MS;/);
  assert.doesNotMatch(command, /AUTO_SELECT_BACKOFF/);
});

test("unsafe close and index-racy multi-space actions are absent from UI and README", async () => {
  const [command, displayActions, readme] = await Promise.all([
    readFile("src/switch-windows-yabai.tsx", "utf8"),
    readFile("src/display-actions-yabai.tsx", "utf8"),
    readFile("README.md", "utf8"),
  ]);
  for (const unsafe of ["Close Window", "Aggregate to Space", "Disperse Windows for Display", "Move to Empty Space on Current Display"]) {
    assert.doesNotMatch(command + displayActions, new RegExp(unsafe));
    assert.doesNotMatch(readme, new RegExp(unsafe));
  }
});

test("web fallback is limited to unprefixed All scope", async () => {
  const { shouldShowWebFallbackForScope } = await import("../src/utils/searchScope.ts");
  assert.equal(shouldShowWebFallbackForScope("all", false, false), true);
  for (const scope of ["windows", "applications", "tabs"] as const) {
    assert.equal(shouldShowWebFallbackForScope(scope, false, false), false);
  }
  assert.equal(shouldShowWebFallbackForScope("all", true, false), false);
  assert.equal(shouldShowWebFallbackForScope("all", false, true), false);
});
