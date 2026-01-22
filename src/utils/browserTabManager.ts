/**
 * Browser Tab Manager - Query and cache browser tabs from multiple browsers
 * Follows the pattern established by yabaiQueryManager.ts
 */

import { BrowserTab, BrowserType } from "../models";
import { runAppleScript, isBrowserNotRunning, isAppleScriptPermissionError } from "./appleScriptBridge";
import { yabaiQueryManager } from "./yabaiQueryManager";

interface TabCache {
  data: BrowserTab[] | null;
  timestamp: number;
  inFlight: Promise<BrowserTab[]> | null;
}

/**
 * All supported Chromium-based browsers (share same AppleScript API)
 */
const CHROMIUM_BROWSERS: BrowserType[] = [
  BrowserType.CHROME,
  BrowserType.VIVALDI,
  BrowserType.BRAVE,
  BrowserType.EDGE,
  BrowserType.ARC,
];

/**
 * Maximum tabs to fetch per browser (performance limit)
 */
const MAX_TABS_PER_BROWSER = 200;

/**
 * Cache TTL in milliseconds
 */
const CACHE_TTL_MS = 5000; // 5 seconds

class BrowserTabManager {
  private cache: Map<BrowserType, TabCache> = new Map();
  private permissionErrors: Set<BrowserType> = new Set();

  constructor() {
    // Initialize cache for each browser
    for (const browser of Object.values(BrowserType)) {
      this.cache.set(browser as BrowserType, {
        data: null,
        timestamp: 0,
        inFlight: null,
      });
    }
  }

  /**
   * Query tabs from a specific browser
   */
  async queryTabs(browser: BrowserType): Promise<BrowserTab[]> {
    // Skip browsers with known permission errors
    if (this.permissionErrors.has(browser)) {
      return [];
    }

    const cacheEntry = this.cache.get(browser)!;

    // Return in-flight promise if already querying
    if (cacheEntry.inFlight) {
      return cacheEntry.inFlight;
    }

    // Return cached data if still fresh
    const now = Date.now();
    if (cacheEntry.data && now - cacheEntry.timestamp < CACHE_TTL_MS) {
      return cacheEntry.data;
    }

    // Start new query
    const promise = this.fetchTabs(browser);
    cacheEntry.inFlight = promise;

    try {
      const tabs = await promise;
      cacheEntry.data = tabs;
      cacheEntry.timestamp = Date.now();
      return tabs;
    } catch (error) {
      // Handle permission errors
      if (isAppleScriptPermissionError(error)) {
        console.warn(`Permission denied for ${browser}, skipping future queries`);
        this.permissionErrors.add(browser);
        return [];
      }

      // Return stale data on other errors
      if (cacheEntry.data) {
        console.warn(`Error querying ${browser}, returning stale data:`, error);
        return cacheEntry.data;
      }

      throw error;
    } finally {
      cacheEntry.inFlight = null;
    }
  }

  /**
   * Query tabs from all running browsers
   */
  async queryAllTabs(): Promise<BrowserTab[]> {
    const runningBrowsers = await this.getRunningBrowsers();

    if (runningBrowsers.length === 0) {
      return [];
    }

    // Query all running browsers in parallel
    const results = await Promise.allSettled(runningBrowsers.map((browser) => this.queryTabs(browser)));

    // Flatten results, skipping failed queries
    const allTabs: BrowserTab[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allTabs.push(...result.value);
      }
    }

    return allTabs;
  }

  /**
   * Get list of browsers that are currently running (using yabai window data)
   */
  async getRunningBrowsers(): Promise<BrowserType[]> {
    try {
      const windows = await yabaiQueryManager.queryWindows();
      const runningApps = new Set(windows.map((w) => w.app));

      const runningBrowsers: BrowserType[] = [];
      for (const browser of Object.values(BrowserType)) {
        if (runningApps.has(browser)) {
          runningBrowsers.push(browser as BrowserType);
        }
      }

      return runningBrowsers;
    } catch (error) {
      console.error("Failed to get running browsers:", error);
      return [];
    }
  }

  /**
   * Focus a specific browser tab
   */
  async focusTab(tab: BrowserTab): Promise<void> {
    const script = this.getFocusTabScript(tab);
    await runAppleScript(script);
  }

  /**
   * Invalidate cache for a specific browser or all browsers
   */
  invalidateCache(browser?: BrowserType): void {
    if (browser) {
      const entry = this.cache.get(browser);
      if (entry) {
        entry.timestamp = 0;
      }
    } else {
      for (const entry of this.cache.values()) {
        entry.timestamp = 0;
      }
    }
  }

  /**
   * Clear permission error state (e.g., after user grants permission)
   */
  clearPermissionErrors(): void {
    this.permissionErrors.clear();
  }

  /**
   * Check if a browser has a known permission error
   */
  hasPermissionError(browser: BrowserType): boolean {
    return this.permissionErrors.has(browser);
  }

  /**
   * Get browsers with permission errors
   */
  getBrowsersWithPermissionErrors(): BrowserType[] {
    return Array.from(this.permissionErrors);
  }

  // ==================== Private Methods ====================

  /**
   * Fetch tabs from a browser using AppleScript
   */
  private async fetchTabs(browser: BrowserType): Promise<BrowserTab[]> {
    if (browser === BrowserType.SAFARI) {
      return this.fetchSafariTabs();
    } else if (browser === BrowserType.FIREFOX) {
      return this.fetchFirefoxTabs();
    } else if (CHROMIUM_BROWSERS.includes(browser)) {
      return this.fetchChromiumTabs(browser);
    }

    return [];
  }

  /**
   * Fetch tabs from Chromium-based browsers (Chrome, Vivaldi, Brave, Edge, Arc)
   */
  private async fetchChromiumTabs(browser: BrowserType): Promise<BrowserTab[]> {
    // AppleScript to get all tabs with their details
    // Returns format: URL|||TITLE|||WINDOW_INDEX|||TAB_INDEX|||IS_ACTIVE
    const script = `
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

    try {
      const result = await runAppleScript(script);
      return this.parseTabOutput(result, browser);
    } catch (error) {
      if (isBrowserNotRunning(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetch tabs from Safari (different AppleScript API)
   */
  private async fetchSafariTabs(): Promise<BrowserTab[]> {
    const script = `
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

    try {
      const result = await runAppleScript(script);
      return this.parseTabOutput(result, BrowserType.SAFARI);
    } catch (error) {
      if (isBrowserNotRunning(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetch tabs from Firefox (limited support - window titles only)
   * Firefox doesn't expose individual tabs via AppleScript
   */
  private async fetchFirefoxTabs(): Promise<BrowserTab[]> {
    const script = `
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

    try {
      const result = await runAppleScript(script);
      return this.parseTabOutput(result, BrowserType.FIREFOX);
    } catch (error) {
      if (isBrowserNotRunning(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Parse tab output from AppleScript into BrowserTab objects
   */
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

  /**
   * Extract domain from URL for display
   */
  private extractDomain(url: string): string {
    try {
      if (!url || url === "about:blank") return "";
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  /**
   * Generate AppleScript to focus a specific tab
   */
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
      // Firefox - just activate the window
      return `
        tell application "Firefox"
          set index of window ${tab.windowIndex} to 1
          activate
        end tell
      `;
    } else {
      // Chromium-based browsers
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

// Export singleton instance
export const browserTabManager = new BrowserTabManager();

// Export class for testing
export { BrowserTabManager };
