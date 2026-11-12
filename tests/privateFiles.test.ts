import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendPrivateFile, ensurePrivateDirectory, replacePrivateFile } from "../src/utils/privateFiles.ts";

function permissionBits(mode: number): number {
  return mode & 0o777;
}

test("focus history directory and files are corrected to private modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "focus-private-"));
  const directory = join(root, "history");
  const file = join(directory, "focus.log");

  await ensurePrivateDirectory(directory);
  await chmod(directory, 0o755);
  await writeFile(file, "old\n", { mode: 0o644 });
  await appendPrivateFile(file, "new\n");
  assert.equal(permissionBits((await stat(directory)).mode), 0o755);
  assert.equal(permissionBits((await stat(file)).mode), 0o600);

  await ensurePrivateDirectory(directory);
  await replacePrivateFile(file, "rotated\n");
  assert.equal(permissionBits((await stat(directory)).mode), 0o700);
  assert.equal(permissionBits((await stat(file)).mode), 0o600);
});
