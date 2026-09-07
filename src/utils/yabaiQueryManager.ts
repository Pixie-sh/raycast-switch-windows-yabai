/** Consolidated, bounded yabai queries with short-lived caching. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { YabaiWindow, YabaiSpace, YabaiDisplay, ENV, YABAI } from "../models";
import { EXEC_FILE_OPTIONS } from "./command";
import { performanceMonitor } from "./performanceMonitor";
import { parseYabaiDisplays, parseYabaiSpaces, parseYabaiWindows } from "./runtimeData";
import { TrailingQueryGate } from "./trailingQuery";

const execFileAsync = promisify(execFile);

interface QueryCache<T> {
  data: T | null;
  timestamp: number;
  gate: TrailingQueryGate;
}

type QueryType = "windows" | "spaces" | "displays";

export class YabaiQueryManager {
  private cache = {
    windows: { data: null, timestamp: 0, gate: new TrailingQueryGate() } as QueryCache<YabaiWindow[]>,
    spaces: { data: null, timestamp: 0, gate: new TrailingQueryGate() } as QueryCache<YabaiSpace[]>,
    displays: { data: null, timestamp: 0, gate: new TrailingQueryGate() } as QueryCache<YabaiDisplay[]>,
  };

  private readonly CACHE_TTL_MS = 2_000;
  private readonly MAX_STALE_AGE_MS = 30_000;

  async queryWindows(): Promise<YabaiWindow[]> {
    return this.performQuery("windows", ["-m", "query", "--windows"]);
  }

  async querySpaces(): Promise<YabaiSpace[]> {
    return this.performQuery("spaces", ["-m", "query", "--spaces"]);
  }

  async queryDisplays(): Promise<YabaiDisplay[]> {
    return this.performQuery("displays", ["-m", "query", "--displays"]);
  }

  private parse(type: QueryType, stdout: string): YabaiWindow[] | YabaiSpace[] | YabaiDisplay[] {
    if (type === "windows") return parseYabaiWindows(stdout) as YabaiWindow[];
    if (type === "spaces") return parseYabaiSpaces(stdout) as YabaiSpace[];
    return parseYabaiDisplays(stdout) as YabaiDisplay[];
  }

  private async performQuery<T>(type: QueryType, args: string[]): Promise<T> {
    const cacheEntry = this.cache[type] as QueryCache<unknown>;
    const now = Date.now();
    if (cacheEntry.data !== null && now - cacheEntry.timestamp < this.CACHE_TTL_MS) {
      performanceMonitor.recordMetric(`${type}-query-cache-hit`, 0);
      return cacheEntry.data as T;
    }

    return cacheEntry.gate.run((generation) =>
      performanceMonitor.measureAsync(`${type}-query`, async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const { stdout } = await execFileAsync(YABAI, args, {
              ...EXEC_FILE_OPTIONS,
              env: ENV,
              encoding: "utf8",
            });
            const parsed = this.parse(type, stdout);
            if (cacheEntry.gate.isCurrent(generation)) {
              cacheEntry.data = parsed;
              cacheEntry.timestamp = Date.now();
            }
            return parsed as T;
          } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 60));
          }
        }
        if (cacheEntry.data !== null && Date.now() - cacheEntry.timestamp <= this.MAX_STALE_AGE_MS) {
          return cacheEntry.data as T;
        }
        throw lastError instanceof Error ? lastError : new Error(`Failed to query ${type}`);
      }),
    ) as Promise<T>;
  }

  invalidateCache(type?: QueryType): void {
    if (type) {
      this.cache[type].timestamp = 0;
      this.cache[type].gate.invalidate();
      return;
    }
    Object.values(this.cache).forEach((entry) => {
      entry.timestamp = 0;
      entry.gate.invalidate();
    });
  }
}

export const yabaiQueryManager = new YabaiQueryManager();
