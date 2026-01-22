/**
 * Focus History Manager - Reads and manages window focus history from yabai signals
 * Enables accurate "recently used" sorting even for focus changes via skhd/mouse
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { FocusHistoryEntry, ENV } from "../models";

/**
 * Path to the focus history log file
 * Written by yabai signal: window_focused event
 */
const FOCUS_HISTORY_DIR = path.join(ENV.HOME, ".local", "share", "raycast-yabai");
const FOCUS_HISTORY_FILE = path.join(FOCUS_HISTORY_DIR, "focus_history.log");

/**
 * Maximum entries to keep in history
 */
const MAX_HISTORY_ENTRIES = 500;

/**
 * Maximum entries before triggering rotation
 */
const ROTATION_THRESHOLD = 1000;

class FocusHistoryManager {
  private cache: Map<number, number> | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 2000; // 2 seconds

  /**
   * Get the timestamp when a window was last focused
   * Returns 0 if window has never been focused (or not tracked)
   */
  async getLastFocusTime(windowId: number): Promise<number> {
    const history = await this.getHistory();
    return history.get(windowId) || 0;
  }

  /**
   * Get focus times for multiple windows at once
   * More efficient than calling getLastFocusTime multiple times
   */
  async getFocusTimes(windowIds: number[]): Promise<Map<number, number>> {
    const history = await this.getHistory();
    const result = new Map<number, number>();

    for (const id of windowIds) {
      result.set(id, history.get(id) || 0);
    }

    return result;
  }

  /**
   * Get all focus history as a map of windowId -> timestamp
   */
  async getHistory(): Promise<Map<number, number>> {
    // Check cache first
    const now = Date.now();
    if (this.cache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cache;
    }

    // Read and parse the log file
    const entries = await this.readHistoryFile();

    // Build map with most recent timestamp for each window
    const history = new Map<number, number>();
    for (const entry of entries) {
      const existing = history.get(entry.windowId);
      if (!existing || entry.timestamp > existing) {
        history.set(entry.windowId, entry.timestamp);
      }
    }

    // Update cache
    this.cache = history;
    this.cacheTimestamp = now;

    return history;
  }

  /**
   * Manually record a focus event (e.g., when extension focuses a window)
   * This supplements the yabai signal log
   */
  async recordFocus(windowId: number): Promise<void> {
    try {
      await this.ensureDirectoryExists();

      const timestamp = Math.floor(Date.now() / 1000);
      const entry = `${timestamp}:${windowId}\n`;

      await writeFile(FOCUS_HISTORY_FILE, entry, { flag: "a" });

      // Update cache immediately
      if (this.cache) {
        this.cache.set(windowId, timestamp);
      }

      // Check if rotation is needed
      await this.rotateIfNeeded();
    } catch (error) {
      console.error("Failed to record focus:", error);
    }
  }

  /**
   * Invalidate the cache to force re-read on next access
   */
  invalidateCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Check if focus tracking is set up (yabai signal installed)
   */
  async isSetupComplete(): Promise<boolean> {
    return existsSync(FOCUS_HISTORY_FILE);
  }

  /**
   * Get the path to the focus history file (for setup instructions)
   */
  getHistoryFilePath(): string {
    return FOCUS_HISTORY_FILE;
  }

  /**
   * Get the directory path (for setup instructions)
   */
  getHistoryDirPath(): string {
    return FOCUS_HISTORY_DIR;
  }

  // ==================== Private Methods ====================

  /**
   * Read and parse the history log file
   */
  private async readHistoryFile(): Promise<FocusHistoryEntry[]> {
    try {
      if (!existsSync(FOCUS_HISTORY_FILE)) {
        return [];
      }

      const content = await readFile(FOCUS_HISTORY_FILE, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      const entries: FocusHistoryEntry[] = [];

      for (const line of lines) {
        const parsed = this.parseLine(line);
        if (parsed) {
          entries.push(parsed);
        }
      }

      return entries;
    } catch (error) {
      console.error("Failed to read focus history:", error);
      return [];
    }
  }

  /**
   * Parse a single log line: "timestamp:windowId"
   */
  private parseLine(line: string): FocusHistoryEntry | null {
    const parts = line.split(":");
    if (parts.length >= 2) {
      const timestamp = parseInt(parts[0], 10);
      const windowId = parseInt(parts[1], 10);

      if (!isNaN(timestamp) && !isNaN(windowId) && windowId > 0) {
        return { timestamp, windowId };
      }
    }
    return null;
  }

  /**
   * Ensure the history directory exists
   */
  private async ensureDirectoryExists(): Promise<void> {
    if (!existsSync(FOCUS_HISTORY_DIR)) {
      await mkdir(FOCUS_HISTORY_DIR, { recursive: true });
    }
  }

  /**
   * Rotate the log file if it exceeds the threshold
   * Keeps only the most recent MAX_HISTORY_ENTRIES entries
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      if (!existsSync(FOCUS_HISTORY_FILE)) {
        return;
      }

      const content = await readFile(FOCUS_HISTORY_FILE, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      if (lines.length > ROTATION_THRESHOLD) {
        console.log(`Focus history has ${lines.length} entries, rotating to ${MAX_HISTORY_ENTRIES}`);

        // Keep only the most recent entries
        const recentLines = lines.slice(-MAX_HISTORY_ENTRIES);
        await writeFile(FOCUS_HISTORY_FILE, recentLines.join("\n") + "\n");

        // Invalidate cache after rotation
        this.invalidateCache();
      }
    } catch (error) {
      console.error("Failed to rotate focus history:", error);
    }
  }
}

// Export singleton instance
export const focusHistoryManager = new FocusHistoryManager();

// Export class for testing
export { FocusHistoryManager };

/**
 * Merge extension usage times with yabai focus history
 * Prefers yabai history when available (more accurate for external focus changes)
 * Falls back to extension usage times for windows not in yabai history
 */
export async function getMergedFocusTimes(
  extensionUsageTimes: Record<string, number>,
  windowIds: number[],
): Promise<Record<number, number>> {
  const yabaiFocusTimes = await focusHistoryManager.getFocusTimes(windowIds);
  const merged: Record<number, number> = {};

  for (const windowId of windowIds) {
    const yabaiTime = yabaiFocusTimes.get(windowId) || 0;
    const extensionTime = extensionUsageTimes[windowId] || 0;

    // Use the more recent timestamp
    // yabai times are in seconds, extension times are in milliseconds
    const yabaiTimeMs = yabaiTime * 1000;
    merged[windowId] = Math.max(yabaiTimeMs, extensionTime);
  }

  return merged;
}
