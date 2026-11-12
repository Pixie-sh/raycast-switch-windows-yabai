import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { FOCUS_RECORDER_CONTENT, isCurrentFocusTrackingSetup } from "../src/utils/focusTrackingState.ts";

const execFileAsync = promisify(execFile);

function permissionBits(mode: number): number {
  return mode & 0o777;
}

test("legacy or incomplete focus tracking is not accepted as format v2", () => {
  const complete = {
    historyFileExists: true,
    recorderFileExists: true,
    formatMarker: "2\n",
    recorderContent: FOCUS_RECORDER_CONTENT,
    expectedSignalAction: "/tmp/record-focus.sh /opt/homebrew/bin/yabai /tmp/focus_history.log",
    signals: [{
      event: "window_focused",
      label: "raycast_focus_tracker",
      action: "/tmp/record-focus.sh /opt/homebrew/bin/yabai /tmp/focus_history.log",
    }],
  };
  assert.equal(isCurrentFocusTrackingSetup(complete), true);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, formatMarker: "1\n" }), false);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, signals: [] }), false);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, recorderFileExists: false }), false);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, recorderContent: "#!/bin/bash\nexit 0\n" }), false);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, signals: [{ ...complete.signals[0], event: "space_changed" }] }), false);
  assert.equal(isCurrentFocusTrackingSetup({ ...complete, signals: [{ ...complete.signals[0], action: "/tmp/other" }] }), false);
});

test("focus tracking setup creates private history storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "focus-setup-home-"));
  const bin = join(home, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const yabai = join(bin, "yabai");
  await writeFile(
    yabai,
    '#!/bin/bash\nif [[ "$*" == *"signal --list"* ]]; then printf "[]\\n"; elif [[ "$*" == *"query --windows"* ]]; then printf \'{"id":1,"pid":2,"app":"Code","title":"A","space":1}\\n\'; fi\nexit 0\n',
    { mode: 0o700 },
  );
  await chmod(yabai, 0o700);

  await execFileAsync("/bin/bash", ["scripts/setup-focus-tracking.sh"], {
    cwd: process.cwd(),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });

  const directory = join(home, ".local", "share", "raycast-yabai");
  assert.equal(permissionBits((await stat(directory)).mode), 0o700);
  const history = join(directory, "focus_history.log");
  assert.equal(permissionBits((await stat(history)).mode), 0o600);
  assert.equal(permissionBits((await stat(join(directory, "format-v2"))).mode), 0o600);
  const recorder = join(directory, "record-focus.sh");
  assert.equal(await readFile(recorder, "utf8"), FOCUS_RECORDER_CONTENT);
  assert.match(await readFile(recorder, "utf8"), /\/bin\/date/);

  await chmod(history, 0o644);
  await execFileAsync(recorder, [yabai, history], { env: { YABAI_WINDOW_ID: "1" } });
  assert.equal(permissionBits((await stat(history)).mode), 0o600);
});
