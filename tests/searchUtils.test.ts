import assert from "node:assert/strict";
import test from "node:test";
import Fuse from "fuse.js";

import { getAdjacentSwapVariants, getDefaultSelectedItemId, searchItems } from "../src/utils/searchUtils.ts";

test("short transposition variants include the corrected query", () => {
  assert.ok(getAdjacentSwapVariants("cdoe").includes("code"));
});

test("active search selects only the first visible item", () => {
  assert.equal(
    getDefaultSelectedItemId({ hasSearchText: true, emptySearchItemId: "stale", visibleItemIds: ["visible"] }),
    "visible",
  );
});

test("searchItems ranks exact primary-field matches and handles a transposition", () => {
  const items = [
    { app: "Code", title: "Notes" },
    { app: "Notes", title: "Code" },
    { app: "Codex", title: "Project" },
  ];
  const fields = [
    { getValue: (item: (typeof items)[number]) => item.app, priority: 0 },
    { getValue: (item: (typeof items)[number]) => item.title, priority: 1 },
  ];
  const fuse = new Fuse(items, { keys: ["app", "title"] });

  assert.deepEqual(searchItems({ items, query: "code", fields, fuse }), [items[0], items[2], items[1]]);
  assert.deepEqual(searchItems({ items, query: "cdoe", fields, fuse }), [items[0], items[2], items[1]]);
});
