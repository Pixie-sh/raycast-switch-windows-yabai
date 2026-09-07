import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {
  buildAtomicCloseTabScript,
  buildAtomicFocusTabScript,
  buildBrowserQueryScript,
  canCloseBrowserTab,
  parseBrowserTabCache,
  parseBrowserTabOutput,
  resolveLiveTab,
} from "../src/utils/browserTabData.ts";

test("browser query serialization compiles as AppleScript", async () => {
  const script = buildBrowserQueryScript("Safari");
  assert.match(script, /urlBase64/);
  await execFileAsync("/usr/bin/osacompile", ["-e", script, "-o", "/tmp/raycast-yabai-browser-test.scpt"]);
});

test("atomic close scripts compile when the app dictionary is installed and fail closed on duplicates", async () => {
  const safariScript = buildAtomicCloseTabScript("Safari");
  await execFileAsync("/usr/bin/osacompile", ["-e", safariScript, "-o", "/tmp/raycast-yabai-close-Safari.scpt"]);

  for (const browser of ["Safari", "Google Chrome"]) {
    const script = buildAtomicCloseTabScript(browser);
    assert.match(script, /on run argv/);
    assert.match(script, /expectedURL/);
    assert.match(script, /matchCount is not 1/);
    assert.ok(script.indexOf("matchCount is not 1") < script.indexOf("close tab"));
  }
});

test("tab focus combines identity lookup and mutation in one duplicate-safe AppleScript", async () => {
  const safariScript = buildAtomicFocusTabScript("Safari");
  await execFileAsync("/usr/bin/osacompile", ["-e", safariScript, "-o", "/tmp/raycast-yabai-focus-Safari.scpt"]);
  for (const browser of ["Safari", "Google Chrome", "Firefox"]) {
    const script = buildAtomicFocusTabScript(browser);
    assert.match(script, /on run argv/);
    assert.match(script, /expectedURL/);
    assert.match(script, /expectedTitle/);
    assert.match(script, /matchCount is not 1/);
    const guard = script.indexOf("matchCount is not 1");
    const mutations = ["set current tab", "set active tab index", "set index of window"]
      .map((text) => script.indexOf(text))
      .filter((index) => index >= 0);
    assert.ok(mutations.length > 0 && guard >= 0 && guard < Math.min(...mutations));
  }
});

test("Chrome atomic focus AppleScript compiles when Chrome is installed", async (t) => {
  if (!existsSync("/Applications/Google Chrome.app")) return t.skip("Google Chrome is not installed");
  await execFileAsync("/usr/bin/osacompile", [
    "-e",
    buildAtomicFocusTabScript("Google Chrome"),
    "-o",
    "/tmp/raycast-yabai-focus-Chrome.scpt",
  ]);
});

test("browser tab records are parsed as delimiter-safe JSON lines", () => {
  const output = [
    JSON.stringify({
      url: "https://example.com/a|||b",
      title: "A ||| B",
      windowIndex: 1,
      tabIndex: 2,
      isActive: false,
    }),
  ].join("\n");
  const tabs = parseBrowserTabOutput(output, "Safari");
  assert.equal(tabs[0].url, "https://example.com/a|||b");
  assert.equal(tabs[0].title, "A ||| B");
});

test("stale positional tab actions resolve current position by identity", () => {
  const stale = {
    id: "Safari-1-2",
    browser: "Safari",
    windowIndex: 1,
    tabIndex: 2,
    url: "https://a.test",
    title: "A",
    isActive: false,
    domain: "a.test",
  };
  const live = [
    { ...stale, id: "Safari-2-4", windowIndex: 2, tabIndex: 4 },
    { ...stale, id: "Safari-1-2", url: "https://wrong.test", title: "Wrong" },
  ];
  assert.deepEqual(resolveLiveTab(stale, live), live[0]);
  assert.equal(resolveLiveTab({ ...stale, url: "https://gone.test" }, live), undefined);

  const ambiguous = [
    { ...stale, id: "Safari-2-4", windowIndex: 2, tabIndex: 4 },
    { ...stale, id: "Safari-3-5", windowIndex: 3, tabIndex: 5 },
  ];
  assert.equal(resolveLiveTab(stale, ambiguous), undefined);
  assert.equal(resolveLiveTab(stale, [stale, ambiguous[0]]), undefined);
});

test("persisted tab cache validates schema and accepts fresh empty results", () => {
  assert.deepEqual(parseBrowserTabCache('{"tabs":[],"timestamp":9900}', 10_000, 200), []);
  assert.equal(parseBrowserTabCache('{"tabs":[{}],"timestamp":9900}', 10_000, 200), null);
  assert.equal(parseBrowserTabCache('{"tabs":[],"timestamp":9000}', 10_000, 200), null);
  assert.equal(parseBrowserTabCache('{"tabs":[],"timestamp":80000}', 10_000, 200), null);
  assert.equal(parseBrowserTabCache('{"tabs":[],"timestamp":10001}', 10_000, 200), null);
});

test("browser records reject malformed base64", () => {
  const output = JSON.stringify({
    urlBase64: "%%%",
    titleBase64: "QQ==",
    windowIndex: 1,
    tabIndex: 1,
    isActive: true,
  });
  assert.throws(() => parseBrowserTabOutput(output, "Safari"), /base64/i);
  assert.throws(
    () =>
      parseBrowserTabOutput(
        JSON.stringify({
          urlBase64: "AB==",
          titleBase64: "QQ==",
          windowIndex: 1,
          tabIndex: 1,
          isActive: true,
        }),
        "Safari",
      ),
    /base64/i,
  );
});

test("Firefox window placeholders do not expose incompatible close-tab behavior", () => {
  assert.equal(canCloseBrowserTab("Firefox"), false);
  assert.equal(canCloseBrowserTab("Safari"), true);
});
