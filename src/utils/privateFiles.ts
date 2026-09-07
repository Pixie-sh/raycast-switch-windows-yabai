import { chmod, mkdir, writeFile } from "node:fs/promises";

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function appendPrivateFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { flag: "a", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function replacePrivateFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
}
