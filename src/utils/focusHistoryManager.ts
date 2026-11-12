/** Durable focus history keyed by stable app/title fingerprints. */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ENV, YABAI, YabaiWindow } from "../models";
import { EXEC_FILE_OPTIONS } from "./command";
import { getWindowFingerprint, getWindowIdUsageKey, UsageEntry } from "./windowState";
import { appendPrivateFile, ensurePrivateDirectory, replacePrivateFile } from "./privateFiles";
import { isCurrentFocusTrackingSetup } from "./focusTrackingState";

const FOCUS_HISTORY_DIR = path.join(process.env.HOME ?? homedir(), ".local", "share", "raycast-yabai");
const FOCUS_HISTORY_FILE = path.join(FOCUS_HISTORY_DIR, "focus_history.log");
const FOCUS_RECORDER_FILE = path.join(FOCUS_HISTORY_DIR, "record-focus.sh");
const FOCUS_FORMAT_MARKER = path.join(FOCUS_HISTORY_DIR, "format-v2");
const MAX_HISTORY_ENTRIES = 500;
const ROTATION_THRESHOLD = 1000;
const execFileAsync = promisify(execFile);

interface StableFocusEntry {
  timestamp: number;
  windowId: number;
  fingerprint: string;
}

function exactHistoryKey(windowId: number, fingerprint: string): string {
  return `${windowId}\u001e${fingerprint}`;
}

export class FocusHistoryManager {
  private cache: Map<string, number> | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 2_000;
  private writeQueue: Promise<void> = Promise.resolve();

  async getFocusTimes(windows: YabaiWindow[]): Promise<Map<number, number>> {
    const history = await this.getHistory();
    return new Map(
      windows.map((window) => {
        const fingerprint = getWindowFingerprint(window);
        const exact = history.get(exactHistoryKey(window.id, fingerprint));
        return [window.id, exact ?? 0];
      }),
    );
  }

  async getHistory(): Promise<Map<string, number>> {
    const now = Date.now();
    if (this.cache && now - this.cacheTimestamp < this.CACHE_TTL_MS) return this.cache;
    const entries = await this.readHistoryFile();
    const history = new Map<string, number>();
    for (const entry of entries) {
      const key = exactHistoryKey(entry.windowId, entry.fingerprint);
      const existing = history.get(key) ?? 0;
      if (entry.timestamp > existing) history.set(key, entry.timestamp);
    }
    this.cache = history;
    this.cacheTimestamp = now;
    return history;
  }

  async recordFocus(window: Pick<YabaiWindow, "id" | "app" | "title">): Promise<void> {
    return this.recordFocusAt(window, Math.floor(Date.now() / 1000));
  }

  async recordFocusAt(window: Pick<YabaiWindow, "id" | "app" | "title">, timestampSeconds: number): Promise<void> {
    const operation = async () => {
      await this.ensureDirectoryExists();
      const entry: StableFocusEntry = {
        timestamp: timestampSeconds,
        windowId: window.id,
        fingerprint: getWindowFingerprint(window as YabaiWindow),
      };
      await appendPrivateFile(FOCUS_HISTORY_FILE, `${JSON.stringify(entry)}\n`);
      if (this.cache) {
        const key = exactHistoryKey(entry.windowId, entry.fingerprint);
        const existing = this.cache.get(key) ?? 0;
        if (entry.timestamp > existing) this.cache.set(key, entry.timestamp);
      }
      await this.rotateIfNeeded();
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
  }

  async isSetupComplete(): Promise<boolean> {
    try {
      const formatMarker = existsSync(FOCUS_FORMAT_MARKER) ? await readFile(FOCUS_FORMAT_MARKER, "utf8") : null;
      const recorderContent = existsSync(FOCUS_RECORDER_FILE) ? await readFile(FOCUS_RECORDER_FILE, "utf8") : null;
      const { stdout } = await execFileAsync(YABAI, ["-m", "signal", "--list"], {
        ...EXEC_FILE_OPTIONS,
        env: ENV,
        encoding: "utf8",
      });
      const signals = JSON.parse(stdout) as Array<{ event?: unknown; label?: unknown; action?: unknown }>;
      return isCurrentFocusTrackingSetup({
        historyFileExists: existsSync(FOCUS_HISTORY_FILE),
        recorderFileExists: existsSync(FOCUS_RECORDER_FILE),
        formatMarker,
        recorderContent,
        expectedSignalAction: `${FOCUS_RECORDER_FILE} ${YABAI} ${FOCUS_HISTORY_FILE}`,
        signals: Array.isArray(signals) ? signals : [],
      });
    } catch {
      return false;
    }
  }

  getHistoryFilePath(): string {
    return FOCUS_HISTORY_FILE;
  }

  getHistoryDirPath(): string {
    return FOCUS_HISTORY_DIR;
  }

  private async readHistoryFile(): Promise<StableFocusEntry[]> {
    try {
      if (!existsSync(FOCUS_HISTORY_FILE)) return [];
      const content = await readFile(FOCUS_HISTORY_FILE, "utf8");
      return content
        .split("\n")
        .map((line) => this.parseLine(line))
        .filter((entry): entry is StableFocusEntry => entry !== null);
    } catch (error) {
      console.error("Failed to read focus history:", error);
      return [];
    }
  }

  private parseLine(line: string): StableFocusEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        typeof parsed.timestamp === "number" &&
        typeof parsed.windowId === "number" &&
        typeof parsed.fingerprint === "string" &&
        parsed.fingerprint.length > 0
      ) {
        return parsed as unknown as StableFocusEntry;
      }
    } catch {
      const tab = trimmed.indexOf("\t");
      if (tab > 0) {
        const timestamp = Number(trimmed.slice(0, tab));
        try {
          const window = JSON.parse(trimmed.slice(tab + 1)) as Record<string, unknown>;
          if (
            Number.isFinite(timestamp) &&
            typeof window.id === "number" &&
            typeof window.app === "string" &&
            typeof window.title === "string"
          ) {
            return {
              timestamp,
              windowId: window.id,
              fingerprint: getWindowFingerprint(window as unknown as YabaiWindow),
            };
          }
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private async ensureDirectoryExists(): Promise<void> {
    await ensurePrivateDirectory(FOCUS_HISTORY_DIR);
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const content = await readFile(FOCUS_HISTORY_FILE, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > ROTATION_THRESHOLD) {
        await replacePrivateFile(FOCUS_HISTORY_FILE, `${lines.slice(-MAX_HISTORY_ENTRIES).join("\n")}\n`);
        this.invalidateCache();
      }
    } catch (error) {
      console.error("Failed to rotate focus history:", error);
    }
  }
}

export const focusHistoryManager = new FocusHistoryManager();

export async function getMergedFocusTimes(
  usage: Record<string, UsageEntry>,
  windows: YabaiWindow[],
): Promise<Record<number, number>> {
  const yabaiFocusTimes = await focusHistoryManager.getFocusTimes(windows);
  return Object.fromEntries(
    windows.map((window) => {
      const yabaiTimeMs = (yabaiFocusTimes.get(window.id) ?? 0) * 1000;
      const extensionTime = usage[getWindowIdUsageKey(window)]?.lastUsed ?? 0;
      return [window.id, Math.max(yabaiTimeMs, extensionTime)];
    }),
  );
}
