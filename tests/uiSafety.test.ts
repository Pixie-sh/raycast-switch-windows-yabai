import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
