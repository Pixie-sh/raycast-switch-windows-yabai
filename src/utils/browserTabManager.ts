/**
 * Browser Tab Manager - Query and cache browser tabs from multiple browsers
 *
 * Performance strategy on macOS Tahoe:
 * - AppleScript → browser Apple Events can take 5-15+ seconds per browser
 * - LocalStorage persistence: cached tabs show instantly on mount
 * - Background refresh: fresh data loads without blocking the UI
 * - System Events detects running browsers (fast, no yabai dependency)
 * - In-flight dedup prevents duplicate queries
 */

import { existsSync } from "node:fs";
import { LocalStorage } from "@raycast/api";
import { BrowserTab, BrowserType } from "../models";
import { runAppleScript, isBrowserNotRunning, isAppleScriptPermissionError } from "./appleScriptBridge";

const MAX_TABS_PER_BROWSER = 200;
const CACHE_TTL_MS = 30000;

/**
 * Map browser types to their macOS application paths.
 * Only browsers found on disk will be queried.
 */
const BROWSER_APP_PATHS: Record<BrowserType, string[]> = {
  [BrowserType.CHROME]: ["/Applications/Google Chrome.app"],
  [BrowserType.VIVALDI]: ["/Applications/Vivaldi.app"],
  [BrowserType.BRAVE]: ["/Applications/Brave Browser.app"],
  [BrowserType.EDGE]: ["/Applications/Microsoft Edge.app"],
  [BrowserType.ARC]: ["/Applications/Arc.app"],
  [BrowserType.OPERA]: ["/Applications/Opera.app"],
  [BrowserType.OPERA_GX]: ["/Applications/Opera GX.app"],
  [BrowserType.SAFARI]: ["/Applications/Safari.app", "/System/Applications/Safari.app"],
  [BrowserType.FIREFOX]: ["/Applications/Firefox.app"],
};

/** Cached set of installed browsers (checked once at startup). */
const INSTALLED_BROWSERS: BrowserType[] = (Object.entries(BROWSER_APP_PATHS) as [BrowserType, string[]][])
  .filter(([, paths]) => paths.some((p) => existsSync(p)))
  .map(([browser]) => browser);

interface AllTabsCache {
  data: BrowserTab[] | null;
  timestamp: number;
  inFlight: Promise<BrowserTab[]> | null;
}

class BrowserTabManager {
  private allTabsCache: AllTabsCache = { data: null, timestamp: 0, inFlight: null };
  private permissionErrors: Set<BrowserType> = new Set();

  /**
   * Query tabs from all running browsers.
   * Uses in-flight dedup so concurrent calls share the same promise.
   */
  async queryAllTabs(): Promise<BrowserTab[]> {
    if (this.allTabsCache.inFlight) {
      return this.allTabsCache.inFlight;
    }

    const now = Date.now();
    if (this.allTabsCache.data && now - this.allTabsCache.timestamp < CACHE_TTL_MS) {
      return this.allTabsCache.data;
    }

    const promise = this.fetchAllTabs();
    this.allTabsCache.inFlight = promise;

    try {
      const tabs = await promise;
      this.allTabsCache.data = tabs;
      this.allTabsCache.timestamp = Date.now();

      // Persist for instant display on next launch
      if (tabs.length > 0) {
        LocalStorage.setItem("cachedBrowserTabs", JSON.stringify({ tabs, timestamp: Date.now() })).catch(() => {});
      }

      return tabs;
    } catch {
      if (this.allTabsCache.data) {
        return this.allTabsCache.data;
      }
      return [];
    } finally {
      this.allTabsCache.inFlight = null;
    }
  }

  /**
   * Load cached tabs from LocalStorage for instant display on mount.
   * Accepts caches up to 5 minutes old — stale data is better than no data
   * while the slow AppleScript refresh runs in the background.
   */
  async loadCachedTabs(): Promise<BrowserTab[] | null> {
    try {
      const cached = await LocalStorage.getItem<string>("cachedBrowserTabs");
      if (!cached) return null;
      const { tabs, timestamp } = JSON.parse(cached);
      if (Array.isArray(tabs) && tabs.length > 0 && Date.now() - timestamp < 900000) {
        return tabs;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /** Pre-fetch silently (fire-and-forget). */
  preload(): void {
    this.queryAllTabs().catch(() => {});
  }

  /** Focus a specific browser tab. */
  async focusTab(tab: BrowserTab): Promise<void> {
    const script = this.getFocusTabScript(tab);
    await runAppleScript(script);
  }

  /** Invalidate the tab cache. */
  invalidateCache(): void {
    this.allTabsCache.timestamp = 0;
  }

  // ==================== Private Methods ====================

  /**
   * Query all known browser types in parallel.
   * Non-running browsers return [] quickly via isBrowserNotRunning error handler.
   * No dependency on yabai or System Events for browser detection.
   */
  private async fetchAllTabs(): Promise<BrowserTab[]> {
    const allBrowsers = INSTALLED_BROWSERS.filter((b) => !this.permissionErrors.has(b));

    const results = await Promise.allSettled(allBrowsers.map((browser) => this.fetchBrowserTabs(browser)));

    const allTabs: BrowserTab[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allTabs.push(...result.value);
      }
    }
    return allTabs;
  }

  /** Fetch tabs from a single browser using AppleScript. */
  private async fetchBrowserTabs(browser: BrowserType): Promise<BrowserTab[]> {
    try {
      const script = this.getQueryScript(browser);
      const result = await runAppleScript(script);
      return this.parseTabOutput(result, browser);
    } catch (error) {
      if (isAppleScriptPermissionError(error)) {
        this.permissionErrors.add(browser);
      }
      if (isBrowserNotRunning(error)) {
        return [];
      }
      return [];
    }
  }

  /** Build the AppleScript to query tabs from a specific browser. */
  private getQueryScript(browser: BrowserType): string {
    if (browser === BrowserType.SAFARI) {
      return `
        set output to ""
        tell application "Safari"
          set windowCount to count of windows
          repeat with w from 1 to windowCount
            set tabCount to count of tabs of window w
            set currentTab to current tab of window w
            repeat with t from 1 to tabCount
              set theTab to tab t of window w
              set tabURL to URL of theTab
              set tabTitle to name of theTab
              set isActive to (theTab = currentTab)
              set output to output & tabURL & "|||" & tabTitle & "|||" & w & "|||" & t & "|||" & isActive & "\\n"
            end repeat
          end repeat
        end tell
        return output
      `;
    } else if (browser === BrowserType.FIREFOX) {
      return `
        set output to ""
        tell application "Firefox"
          set windowCount to count of windows
          repeat with w from 1 to windowCount
            set winTitle to name of window w
            set output to output & "about:blank|||" & winTitle & "|||" & w & "|||1|||true\\n"
          end repeat
        end tell
        return output
      `;
    } else {
      // Chromium-based
      return `
        set output to ""
        tell application "${browser}"
          set windowCount to count of windows
          repeat with w from 1 to windowCount
            set tabCount to count of tabs of window w
            set activeIdx to active tab index of window w
            repeat with t from 1 to tabCount
              set theTab to tab t of window w
              set tabURL to URL of theTab
              set tabTitle to title of theTab
              set isActive to (t = activeIdx)
              set output to output & tabURL & "|||" & tabTitle & "|||" & w & "|||" & t & "|||" & isActive & "\\n"
            end repeat
          end repeat
        end tell
        return output
      `;
    }
  }

  /** Parse the tab output from AppleScript. */
  private parseTabOutput(output: string, browser: BrowserType): BrowserTab[] {
    const tabs: BrowserTab[] = [];
    const lines = output.split("\n").filter((line) => line.trim());

    for (const line of lines.slice(0, MAX_TABS_PER_BROWSER)) {
      const parts = line.split("|||");
      if (parts.length >= 5) {
        const url = parts[0] || "";
        const title = parts[1] || "Untitled";
        const windowIndex = parseInt(parts[2], 10) || 1;
        const tabIndex = parseInt(parts[3], 10) || 1;
        const isActive = parts[4] === "true";

        tabs.push({
          id: `${browser}-${windowIndex}-${tabIndex}`,
          browser,
          windowIndex,
          tabIndex,
          url,
          title,
          isActive,
          domain: this.extractDomain(url),
        });
      }
    }

    return tabs;
  }

  private extractDomain(url: string): string {
    try {
      if (!url || url === "about:blank") return "";
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  private getFocusTabScript(tab: BrowserTab): string {
    if (tab.browser === BrowserType.SAFARI) {
      return `
        tell application "Safari"
          set current tab of window ${tab.windowIndex} to tab ${tab.tabIndex} of window ${tab.windowIndex}
          set index of window ${tab.windowIndex} to 1
          activate
        end tell
      `;
    } else if (tab.browser === BrowserType.FIREFOX) {
      return `
        tell application "Firefox"
          set index of window ${tab.windowIndex} to 1
          activate
        end tell
      `;
    } else {
      return `
        tell application "${tab.browser}"
          set active tab index of window ${tab.windowIndex} to ${tab.tabIndex}
          set index of window ${tab.windowIndex} to 1
          activate
        end tell
      `;
    }
  }
}

export const browserTabManager = new BrowserTabManager();
export { BrowserTabManager };
