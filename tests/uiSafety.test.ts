import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
