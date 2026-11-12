import assert from "node:assert/strict";
import test from "node:test";

import { runBestEffort } from "../src/utils/bestEffort.ts";

test("best-effort persistence reports failures without rejecting successful work", async () => {
  const errors: unknown[] = [];
  await runBestEffort(
    async () => {
      throw new Error("disk full");
    },
    (error) => errors.push(error),
  );
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /disk full/);
});
