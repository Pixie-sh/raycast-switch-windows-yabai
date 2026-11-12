/** Query, validate, and cache browser tabs safely. */
import { existsSync } from "node:fs";
import { LocalStorage } from "@raycast/api";
import { BrowserTab, BrowserType } from "../models";
import { isAppleScriptPermissionError, isBrowserNotRunning, runAppleScript } from "./appleScriptBridge";
import {
  buildAtomicCloseTabScript,
  buildAtomicFocusTabScript,
  buildBrowserQueryScript,
  canCloseBrowserTab,
  parseBrowserTabCache,
  parseBrowserTabOutput,
  resolveLiveTab,
} from "./browserTabData";
import { TrailingQueryGate } from "./trailingQuery";

const MAX_TABS_PER_BROWSER = 200;
const CACHE_TTL_MS = 30_000;
const PERSISTED_CACHE_MAX_AGE_MS = 5 * 60_000;

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

const INSTALLED_BROWSERS = (Object.entries(BROWSER_APP_PATHS) as [BrowserType, string[]][])
  .filter(([, paths]) => paths.some(existsSync))
  .map(([browser]) => browser);

interface AllTabsCache {
  data: BrowserTab[] | null;
  timestamp: number;
}

export class BrowserTabManager {
  private allTabsCache: AllTabsCache = { data: null, timestamp: 0 };
  private readonly queryGate = new TrailingQueryGate();
  private warnings: string[] = [];

  async queryAllTabs(forceRefresh = false): Promise<BrowserTab[]> {
    if (forceRefresh) {
      this.allTabsCache.timestamp = 0;
      this.queryGate.invalidate();
    }
    if (!forceRefresh && this.allTabsCache.data !== null && Date.now() - this.allTabsCache.timestamp < CACHE_TTL_MS) {
      return this.allTabsCache.data;
    }

    return this.queryGate.run(async (generation) => {
      const promise = this.fetchAllTabs();
      const tabs = await promise;
      const timestamp = Date.now();
      if (this.queryGate.isCurrent(generation)) this.allTabsCache = { data: tabs, timestamp };
      try {
        await LocalStorage.setItem("cachedBrowserTabs", JSON.stringify({ tabs, timestamp }));
      } catch (error) {
        this.warnings.push(
          `Could not persist browser tab cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return tabs;
    });
  }

  async loadCachedTabs(): Promise<BrowserTab[] | null> {
    try {
      const cached = await LocalStorage.getItem<string>("cachedBrowserTabs");
      if (!cached) return null;
      return parseBrowserTabCache(cached, Date.now(), PERSISTED_CACHE_MAX_AGE_MS) as BrowserTab[] | null;
    } catch (error) {
      this.warnings.push(`Could not load browser tab cache: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  preload(): void {
    void this.queryAllTabs();
  }

  async focusTab(staleTab: BrowserTab): Promise<void> {
    await runAppleScript(buildAtomicFocusTabScript(staleTab.browser), [staleTab.url, staleTab.title]);
  }

  async closeTab(staleTab: BrowserTab): Promise<void> {
    if (!canCloseBrowserTab(staleTab.browser))
      throw new Error(`${staleTab.browser} does not support closing individual tabs`);
    await runAppleScript(buildAtomicCloseTabScript(staleTab.browser), [staleTab.url, staleTab.title]);
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.allTabsCache.timestamp = 0;
    this.queryGate.invalidate();
  }

  consumeWarnings(): string[] {
    return this.warnings.splice(0);
  }

  private async getLiveTab(staleTab: BrowserTab): Promise<BrowserTab> {
    const liveTabs = await this.fetchBrowserTabs(staleTab.browser);
    const liveTab = resolveLiveTab(staleTab, liveTabs);
    if (!liveTab) throw new Error("This tab changed or closed; refresh and try again");
    return liveTab;
  }

  private async fetchAllTabs(): Promise<BrowserTab[]> {
    const results = await Promise.allSettled(INSTALLED_BROWSERS.map((browser) => this.fetchBrowserTabs(browser)));
    const tabs: BrowserTab[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") tabs.push(...result.value);
      else
        failures.push(
          `${INSTALLED_BROWSERS[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
    });
    this.warnings.push(...failures);
    return tabs;
  }

  private async fetchBrowserTabs(browser: BrowserType): Promise<BrowserTab[]> {
    try {
      return parseBrowserTabOutput(
        await runAppleScript(buildBrowserQueryScript(browser)),
        browser,
        MAX_TABS_PER_BROWSER,
      ) as BrowserTab[];
    } catch (error) {
      if (isBrowserNotRunning(error)) return [];
      if (isAppleScriptPermissionError(error)) {
        throw error;
      }
      throw error;
    }
  }
}

export const browserTabManager = new BrowserTabManager();
