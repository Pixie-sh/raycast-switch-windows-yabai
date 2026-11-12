export interface RuntimeBrowserTab {
  id: string;
  browser: string;
  windowIndex: number;
  tabIndex: number;
  url: string;
  title: string;
  isActive: boolean;
  domain: string;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function extractDomain(url: string): string {
  try {
    if (!url || url === "about:blank") return "";
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SUPPORTED_BROWSERS = new Set([
  "Google Chrome",
  "Vivaldi",
  "Brave Browser",
  "Microsoft Edge",
  "Arc",
  "Opera",
  "Opera GX",
  "Safari",
  "Firefox",
]);

function isSupportedBrowser(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_BROWSERS.has(value);
}

function isRuntimeBrowserTab(value: unknown): value is RuntimeBrowserTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    isSupportedBrowser(tab.browser) &&
    isPositiveInteger(tab.windowIndex) &&
    isPositiveInteger(tab.tabIndex) &&
    typeof tab.url === "string" &&
    typeof tab.title === "string" &&
    typeof tab.isActive === "boolean" &&
    typeof tab.domain === "string"
  );
}

export function parseBrowserTabCache(raw: string, now: number, maxAgeMs: number): RuntimeBrowserTab[] | null {
  try {
    const parsed = JSON.parse(raw) as { tabs?: unknown; timestamp?: unknown };
    if (
      typeof parsed.timestamp !== "number" ||
      !Number.isFinite(parsed.timestamp) ||
      parsed.timestamp > now ||
      now - parsed.timestamp > maxAgeMs
    )
      return null;
    if (!Array.isArray(parsed.tabs) || !parsed.tabs.every(isRuntimeBrowserTab)) return null;
    return parsed.tabs;
  } catch {
    return null;
  }
}

export function canCloseBrowserTab(browser: string): boolean {
  return isSupportedBrowser(browser) && browser !== "Firefox";
}

export function resolveLiveTab<T extends RuntimeBrowserTab>(stale: RuntimeBrowserTab, liveTabs: T[]): T | undefined {
  const identityMatches = liveTabs.filter(
    (tab) => tab.browser === stale.browser && tab.url === stale.url && tab.title === stale.title,
  );
  return identityMatches.length === 1 ? identityMatches[0] : undefined;
}

export function buildAtomicCloseTabScript(browser: string): string {
  if (!canCloseBrowserTab(browser)) throw new Error(`${browser} does not support closing individual tabs`);
  const titleProperty = browser === "Safari" ? "name" : "title";
  return `on run argv
  set expectedURL to item 1 of argv
  set expectedTitle to item 2 of argv
  tell application "${browser}"
    set matchCount to 0
    set targetWindowIndex to 0
    set targetTabIndex to 0
    repeat with w from 1 to count of windows
      repeat with t from 1 to count of tabs of window w
        set candidateTab to tab t of window w
        if (URL of candidateTab as text) is expectedURL and (${titleProperty} of candidateTab as text) is expectedTitle then
          set matchCount to matchCount + 1
          set targetWindowIndex to w
          set targetTabIndex to t
        end if
      end repeat
    end repeat
    if matchCount is not 1 then error "Tab identity is missing or ambiguous"
    close tab targetTabIndex of window targetWindowIndex
    return "closed"
  end tell
end run`;
}

export function buildAtomicFocusTabScript(browser: string): string {
  if (!isSupportedBrowser(browser)) throw new Error(`Unsupported browser: ${browser}`);
  if (browser === "Firefox") {
    return `on run argv
  set expectedURL to item 1 of argv
  set expectedTitle to item 2 of argv
  tell application "Firefox"
    set matchCount to 0
    set targetWindowIndex to 0
    repeat with w from 1 to count of windows
      if expectedURL is "about:blank" and (name of window w as text) is expectedTitle then
        set matchCount to matchCount + 1
        set targetWindowIndex to w
      end if
    end repeat
    if matchCount is not 1 then error "Tab identity is missing or ambiguous"
    set index of window targetWindowIndex to 1
    activate
    return "focused"
  end tell
end run`;
  }
  const titleProperty = browser === "Safari" ? "name" : "title";
  const mutation =
    browser === "Safari"
      ? `set current tab of window targetWindowIndex to tab targetTabIndex of window targetWindowIndex`
      : `set active tab index of window targetWindowIndex to targetTabIndex`;
  return `on run argv
  set expectedURL to item 1 of argv
  set expectedTitle to item 2 of argv
  tell application "${browser}"
    set matchCount to 0
    set targetWindowIndex to 0
    set targetTabIndex to 0
    repeat with w from 1 to count of windows
      if (count of tabs of window w) > 0 then
        set tabURLs to URL of every tab of window w
        set tabTitles to ${titleProperty} of every tab of window w
        if (count of tabURLs) is not (count of tabTitles) then error "Tabs changed; refresh and try again"
        repeat with t from 1 to count of tabURLs
          if (item t of tabURLs as text) is expectedURL and (item t of tabTitles as text) is expectedTitle then
            set matchCount to matchCount + 1
            set targetWindowIndex to w
            set targetTabIndex to t
          end if
        end repeat
      end if
    end repeat
    if matchCount is not 1 then error "Tab identity is missing or ambiguous"
    ${mutation}
    set index of window targetWindowIndex to 1
    activate
    return "focused"
  end tell
end run`;
}

// Records are joined with ASCII record/unit separators instead of JSON, and tab
// properties are fetched per window in bulk: one Apple event per tab plus a
// shell-out per field took ~40ms per tab, which was seconds for a busy browser.
export const TAB_RECORD_SEPARATOR = "\x1e";
export const TAB_FIELD_SEPARATOR = "\x1f";

export function buildBrowserQueryScript(browser: string): string {
  if (!isSupportedBrowser(browser)) throw new Error(`Unsupported browser: ${browser}`);
  const prelude = `set output to ""
set FS to character id 31
set RS to character id 30
if application "${browser}" is not running then return output`;
  const appendWindowTabs = `
    repeat with t from 1 to count of tabURLs
      set output to output & ((item t of tabURLs) as text) & FS & ((item t of tabTitles) as text) & FS & w & FS & t & FS & (t = activeIdx) & RS
    end repeat`;
  if (browser === "Safari") {
    return `${prelude}
tell application "Safari"
  set wins to windows
  repeat with w from 1 to count of wins
    set win to item w of wins
    set tabURLs to URL of tabs of win
    set tabTitles to name of tabs of win
    set activeIdx to index of current tab of win
    ${appendWindowTabs}
  end repeat
end tell
return output`;
  }
  if (browser === "Firefox") {
    return `${prelude}
tell application "Firefox"
  set wins to windows
  repeat with w from 1 to count of wins
    set output to output & "about:blank" & FS & ((name of item w of wins) as text) & FS & w & FS & 1 & FS & true & RS
  end repeat
end tell
return output`;
  }
  return `${prelude}
tell application "${browser}"
  set wins to windows
  repeat with w from 1 to count of wins
    set win to item w of wins
    set tabURLs to URL of tabs of win
    set tabTitles to title of tabs of win
    set activeIdx to active tab index of win
    ${appendWindowTabs}
  end repeat
end tell
return output`;
}

export function parseBrowserTabOutput(output: string, browser: string, maxTabs = 200): RuntimeBrowserTab[] {
  if (!isSupportedBrowser(browser)) throw new Error(`Unsupported browser: ${browser}`);
  const records = output
    .split(TAB_RECORD_SEPARATOR)
    .filter((record) => record.trim())
    .slice(0, maxTabs);
  return records.map((record) => {
    const fields = record.split(TAB_FIELD_SEPARATOR);
    if (fields.length !== 5) throw new Error(`Invalid browser tab data from ${browser}`);
    const [url, rawTitle, rawWindowIndex, rawTabIndex, rawIsActive] = fields;
    const windowIndex = Number(rawWindowIndex);
    const tabIndex = Number(rawTabIndex);
    if (!isPositiveInteger(windowIndex) || !isPositiveInteger(tabIndex) || !/^(true|false)$/.test(rawIsActive)) {
      throw new Error(`Invalid browser tab data from ${browser}`);
    }
    const title = rawTitle.trim();
    return {
      id: `${browser}-${windowIndex}-${tabIndex}`,
      browser,
      windowIndex,
      tabIndex,
      url,
      title: title || "Untitled",
      isActive: rawIsActive === "true",
      domain: extractDomain(url),
    };
  });
}
