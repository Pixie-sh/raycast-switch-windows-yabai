import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  createSpaceOnDisplay,
  assertSafeWindowCloseSupported,
  assertSafeSpaceDestructionSupported,
  findCreatedSpace,
  getAdjacentSpace,
  getCreateSpaceArgs,
  getEmptySpaceCandidates,
  isExpectedWindow,
  isSameWindowIdentity,
  isUnsafeSpaceIndexMutationDisabled,
  planAggregation,
  planDispersal,
} from "../src/utils/windowOperations.ts";

const execFileAsync = promisify(execFile);

test("window close fails closed because Accessibility cannot bind a yabai id atomically", () => {
  assert.throws(assertSafeWindowCloseSupported, /cannot be bound atomically/i);
});

test("space destruction fails closed without a conditional yabai mutation", () => {
  assert.throws(assertSafeSpaceDestructionSupported, /cannot be made atomic/i);
});

test("multi-step space-index mutations are disabled fail closed", () => {
  assert.equal(isUnsafeSpaceIndexMutationDisabled(), true);
});

test("each display-targeted creation identifies exactly its own new space", async () => {
  const snapshots = [
    [{ index: 2, display: 3, windows: [] }],
    [
      { index: 2, display: 3, windows: [] },
      { index: 4, display: 3, windows: [] },
    ],
  ];
  const createCalls: string[][] = [];

  const created = await createSpaceOnDisplay(
    3,
    async () => snapshots.shift() ?? [],
    async (args) => {
      createCalls.push(args);
    },
  );

  assert.equal(created.index, 4);
  assert.deepEqual(createCalls, [["-m", "space", "--create", "3"]]);
  await assert.rejects(
    createSpaceOnDisplay(
      3,
      async () => [
        { index: 2, display: 3, windows: [] },
        { index: 4, display: 3, windows: [] },
        { index: 5, display: 3, windows: [] },
      ],
      async () => undefined,
    ),
    /identify the new space/,
  );
});

test("space creation targets the requested display without relying on focus", () => {
  assert.deepEqual(getCreateSpaceArgs(3), ["-m", "space", "--create", "3"]);
});

test("window identity rejects a recycled id from the same application", () => {
  const liveWindow = { id: 7, app: "Terminal", title: "server", space: 1, display: 1 };
  assert.equal(isExpectedWindow(liveWindow, "Terminal", "server"), true);
  assert.equal(isExpectedWindow(liveWindow, "Terminal", "logs"), false);
  assert.equal(isExpectedWindow(liveWindow, "Safari", "server"), false);
});

test("move and destructive action identity includes id, app, and title", () => {
  const expected = { id: 7, app: "Terminal", title: "server" };
  assert.equal(isSameWindowIdentity(expected, { ...expected, space: 1 }), true);
  assert.equal(isSameWindowIdentity(expected, { ...expected, id: 8, space: 1 }), false);
  assert.equal(isSameWindowIdentity(expected, { ...expected, title: "logs", space: 1 }), false);
  assert.equal(isSameWindowIdentity(expected, { ...expected, app: "Safari", space: 1 }), false);
});

test("empty space candidates are explicit descending indices", () => {
  const spaces = [
    { index: 2, display: 1, windows: [] },
    { index: 4, display: 2, windows: [] },
    { index: 3, display: 1, windows: [{ id: 9 }] },
    { index: 1, display: 1, windows: [] },
  ];

  assert.deepEqual(getEmptySpaceCandidates(spaces), [4, 2, 1]);
});

test("dispersal maps every eligible display window to one local space", () => {
  const windows = [
    { id: 20, display: 2, "is-native-fullscreen": false },
    { id: 21, display: 2, "is-native-fullscreen": true },
    { id: 22, display: 2, "is-native-fullscreen": false },
  ];
  const spaces = [
    { index: 7, display: 2, windows: [] },
    { index: 8, display: 2, windows: [] },
  ];

  assert.deepEqual(planDispersal(windows, spaces, 2), {
    spacesNeeded: 0,
    assignments: [
      { windowId: 20, spaceIndex: 7 },
      { windowId: 22, spaceIndex: 8 },
    ],
    focusSpaceIndex: 7,
  });
});

test("dispersal never assigns ordinary windows to native-fullscreen spaces", () => {
  const windows = [
    { id: 20, display: 2, "is-native-fullscreen": false },
    { id: 22, display: 2, "is-native-fullscreen": false },
  ];
  const spaces = [
    { index: 7, display: 2, windows: [20] },
    { index: 8, display: 2, windows: [99], "is-native-fullscreen": true },
  ];

  assert.deepEqual(planDispersal(windows, spaces, 2), {
    spacesNeeded: 1,
    assignments: [{ windowId: 20, spaceIndex: 7 }],
    focusSpaceIndex: 7,
  });
});

test("created space is identified by display-scoped set difference", () => {
  const before = [
    { index: 2, display: 2, windows: [] },
    { index: 5, display: 2, windows: [] },
  ];
  const after = [
    { index: 2, display: 2, windows: [] },
    { index: 5, display: 2, windows: [] },
    { index: 6, display: 2, windows: [] },
    { index: 7, display: 3, windows: [] },
  ];

  assert.equal(findCreatedSpace(before, after, 2)?.index, 6);
  assert.equal(findCreatedSpace(before, [...after, { index: 8, display: 2, windows: [] }], 2), undefined);
});

test("space navigation wraps within the focused display", () => {
  const spaces = [
    { index: 1, display: 1, windows: [] },
    { index: 4, display: 2, windows: [] },
    { index: 6, display: 2, windows: [] },
  ];

  assert.equal(getAdjacentSpace(spaces, 6, 2, "next"), 4);
  assert.equal(getAdjacentSpace(spaces, 4, 2, "previous"), 6);
});

test("aggregation excludes native-fullscreen source windows and targets", () => {
  const windows = [
    { id: 10, app: "Code", title: "A", display: 2, space: 4, "is-native-fullscreen": false },
    { id: 11, app: "Code", title: "Fullscreen", display: 2, space: 6, "is-native-fullscreen": true },
  ];
  const spaces = [
    { index: 4, display: 2, windows: [10] },
    { index: 7, display: 2, windows: [], "is-native-fullscreen": true },
    { index: 8, display: 2, windows: [] },
  ];
  assert.deepEqual(planAggregation(windows, spaces, windows[0]), {
    matchingWindowIds: [10],
    targetDisplay: 2,
    targetSpaceIndex: 8,
    needsCreate: false,
  });
  assert.throws(() => planAggregation(windows, spaces, windows[1]), /native fullscreen/i);
});

test("aggregation counts matching app windows and chooses an empty space on their display", () => {
  const windows = [
    { id: 10, app: "Code", title: "A", display: 2, space: 4 },
    { id: 11, app: "Mail", title: "Inbox", display: 2, space: 4 },
    { id: 12, app: "code", title: "B", display: 2, space: 6 },
  ];
  const spaces = [
    { index: 1, display: 1, windows: [] },
    { index: 4, display: 2, windows: [10, 11] },
    { index: 7, display: 2, windows: [] },
  ];

  assert.deepEqual(planAggregation(windows, spaces, windows[0]), {
    matchingWindowIds: [10, 12],
    targetDisplay: 2,
    targetSpaceIndex: 7,
    needsCreate: false,
  });
});
