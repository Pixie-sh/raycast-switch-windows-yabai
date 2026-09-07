import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { userInfo } from "node:os";

export const COMMAND_TIMEOUT_MS = 15_000;
const SAFE_ENV_KEYS = ["HOME", "USER", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

export function buildCommandEnv(source: NodeJS.ProcessEnv, fallbackUser = userInfo().username): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    SAFE_ENV_KEYS.flatMap((key) => (source[key] === undefined ? [] : ([[key, source[key]]] as const))),
  );
  env.USER ||= fallbackUser;
  return env;
}

export const COMMAND_ENV: NodeJS.ProcessEnv = buildCommandEnv(process.env);
export const EXEC_FILE_OPTIONS = {
  env: COMMAND_ENV,
  timeout: COMMAND_TIMEOUT_MS,
  maxBuffer: 10 * 1024 * 1024,
} as const;

export async function validateExecutablePath(candidate: string): Promise<string> {
  const file = await stat(candidate).catch(() => {
    throw new Error(`Yabai path does not exist: ${candidate}`);
  });
  if (!file.isFile()) throw new Error(`Yabai path is not a regular file: ${candidate}`);
  await access(candidate, constants.X_OK).catch(() => {
    throw new Error(`Yabai path is not executable: ${candidate}`);
  });
  return candidate;
}
