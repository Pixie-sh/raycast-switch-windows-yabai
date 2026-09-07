import assert from "node:assert/strict";
import test from "node:test";

import { parseCachedWindows, parseYabaiWindows } from "../src/utils/runtimeData.ts";

test("malformed yabai window objects are rejected before actions can use them", () => {
  assert.throws(() => parseYabaiWindows('[{"id":"7","app":"Code"}]'), /Invalid yabai windows/);
  assert.deepEqual(parseYabaiWindows('[{"id":7,"pid":9,"app":"Code","title":"A","space":1}]'), [
    { id: 7, pid: 9, app: "Code", title: "A", space: 1 },
  ]);
});

test("window cache has a maximum age and permits fresh empty snapshots", () => {
  const emptyCache = JSON.stringify({ windows: [], timestamp: 9_900 });
  assert.deepEqual(parseCachedWindows(emptyCache, 10_000, 200), []);
  assert.equal(parseCachedWindows(emptyCache, 10_200, 200), null);
  assert.equal(parseCachedWindows('{"windows":[],"timestamp":80000}', 10_000, 200), null);
  assert.equal(parseCachedWindows('{"windows":[],"timestamp":10001}', 10_000, 200), null);
  assert.equal(parseCachedWindows('{"windows":[{}],"timestamp":9999}', 10_000, 200), null);
});

test("yabai runtime data requires positive integer identifiers", () => {
  assert.throws(
    () => parseYabaiWindows('[{"id":1.5,"pid":9,"app":"Code","title":"A","space":1}]'),
    /Invalid yabai windows/,
  );
  assert.throws(
    () => parseYabaiWindows('[{"id":7,"pid":-1,"app":"Code","title":"A","space":1}]'),
    /Invalid yabai windows/,
  );
  assert.throws(
    () => parseYabaiWindows('[{"id":7,"pid":0,"app":"Code","title":"A","space":1}]'),
    /Invalid yabai windows/,
  );
});
