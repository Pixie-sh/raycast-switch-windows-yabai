import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCommandEnv, validateExecutablePath } from "../src/utils/command.ts";

test("subprocess environment strips secret-bearing variables", () => {
  const env = buildCommandEnv({
    HOME: "/Users/test",
    USER: "test",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    SHELL: "/tmp/untrusted-shell",
    GITHUB_TOKEN: "secret",
    API_KEY: "secret",
  });
  assert.deepEqual(env, {
    HOME: "/Users/test",
    USER: "test",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
  });
});

test("subprocess environment injects the OS username when USER is absent", () => {
  assert.deepEqual(buildCommandEnv({ HOME: "/Users/test", PATH: "/usr/bin:/bin" }, "test"), {
    HOME: "/Users/test",
    USER: "test",
    PATH: "/usr/bin:/bin",
  });
});

test("custom yabai path must be an executable regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yabai-path-"));
  const file = join(dir, "yabai custom");
  await writeFile(file, "#!/bin/sh\n");
  await assert.rejects(validateExecutablePath(file), /not executable/);
  await chmod(file, 0o755);
  assert.equal(await validateExecutablePath(file), file);
  await assert.rejects(validateExecutablePath(dir), /regular file/);
});
