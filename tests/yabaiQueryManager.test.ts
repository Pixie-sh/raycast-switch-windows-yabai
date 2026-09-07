import assert from "node:assert/strict";
import test from "node:test";
import { TrailingQueryGate, LoadingActivityCounter } from "../src/utils/trailingQuery.ts";

test("loading activity remains true until overlapping stale and trailing queries both settle", () => {
  const counter = new LoadingActivityCounter();
  assert.equal(counter.begin(), true);
  assert.equal(counter.begin(), true);
  assert.equal(counter.end(), true);
  assert.equal(counter.end(), false);
});

test("invalidation during an in-flight query returns a trailing fresh query", async () => {
  const resolvers: Array<(value: string) => void> = [];
  let calls = 0;
  const gate = new TrailingQueryGate();
  const operation = async () => {
    calls += 1;
    return new Promise<string>((resolve) => resolvers.push(resolve));
  };
  const stale = gate.run(operation);
  gate.invalidate();
  const fresh = gate.run(operation);
  assert.notEqual(fresh, stale);
  resolvers.shift()?.("Old");
  assert.equal(await stale, "Old");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  resolvers.shift()?.("Fresh");
  assert.equal(await fresh, "Fresh");
});
