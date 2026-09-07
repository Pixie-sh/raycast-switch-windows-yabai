/* eslint-disable no-useless-escape -- AppleScript strings require literal backslash-quote sequences. */
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

interface SerializedTab {
  url?: string;
  title?: string;
  urlBase64?: string;
  titleBase64?: string;
  windowIndex: number;
  tabIndex: number;
  isActive: boolean;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSerializedTab(value: unknown): value is SerializedTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  const hasUrl = typeof tab.url === "string" || typeof tab.urlBase64 === "string";
  const hasTitle = typeof tab.title === "string" || typeof tab.titleBase64 === "string";
  return (
    hasUrl &&
    hasTitle &&
    isPositiveInteger(tab.windowIndex) &&
    isPositiveInteger(tab.tabIndex) &&
    typeof tab.isActive === "boolean"
  );
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
    ${mutation}
    set index of window targetWindowIndex to 1
    activate
    return "focused"
  end tell
end run`;
}

export function buildBrowserQueryScript(browser: string): string {
  if (!isSupportedBrowser(browser)) throw new Error(`Unsupported browser: ${browser}`);
  const appendRecord = `
      set encodedURL to do shell script "/usr/bin/printf %s " & quoted form of (tabURL as text) & " | /usr/bin/base64 | /usr/bin/tr -d '\\n'"
      set encodedTitle to do shell script "/usr/bin/printf %s " & quoted form of (tabTitle as text) & " | /usr/bin/base64 | /usr/bin/tr -d '\\n'"
      set output to output & "{\\\"urlBase64\\\":\\\"" & encodedURL & "\\\",\\\"titleBase64\\\":\\\"" & encodedTitle & "\\\",\\\"windowIndex\\\":" & w & ",\\\"tabIndex\\\":" & t & ",\\\"isActive\\\":" & isActive & "}" & linefeed
    `;
  if (browser === "Safari") {
    return `set output to ""
tell application "Safari"
  repeat with w from 1 to count of windows
    set currentTab to current tab of window w
    repeat with t from 1 to count of tabs of window w
      set theTab to tab t of window w
      set tabURL to URL of theTab
      set tabTitle to name of theTab
      set isActive to (theTab = currentTab)
      ${appendRecord}
    end repeat
  end repeat
end tell
return output`;
  }
  if (browser === "Firefox") {
    return `set output to ""
tell application "Firefox"
  repeat with w from 1 to count of windows
    set t to 1
    set tabURL to "about:blank"
    set tabTitle to name of window w
    set isActive to true
    ${appendRecord}
  end repeat
end tell
return output`;
  }
  return `set output to ""
tell application "${browser}"
  repeat with w from 1 to count of windows
    set activeIdx to active tab index of window w
    repeat with t from 1 to count of tabs of window w
      set theTab to tab t of window w
      set tabURL to URL of theTab
      set tabTitle to title of theTab
      set isActive to (t = activeIdx)
      ${appendRecord}
    end repeat
  end repeat
end tell
return output`;
}

export function parseBrowserTabOutput(output: string, browser: string, maxTabs = 200): RuntimeBrowserTab[] {
  if (!isSupportedBrowser(browser)) throw new Error(`Unsupported browser: ${browser}`);
  const records = output
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, maxTabs);
  return records.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid browser tab JSON from ${browser}`);
    }
    if (!isSerializedTab(parsed)) throw new Error(`Invalid browser tab data from ${browser}`);
    const decodeBase64 = (value: string, label: string): string => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error(`Invalid ${label} base64 from ${browser}`);
      }
      const decoded = Buffer.from(value, "base64");
      const text = decoded.toString("utf8");
      if (decoded.toString("base64") !== value || !Buffer.from(text, "utf8").equals(decoded)) {
        throw new Error(`Invalid ${label} base64 from ${browser}`);
      }
      return text;
    };
    const url = parsed.url ?? decodeBase64(parsed.urlBase64 ?? "", "URL");
    const title = parsed.title ?? decodeBase64(parsed.titleBase64 ?? "", "title") ?? "Untitled";
    return {
      id: `${browser}-${parsed.windowIndex}-${parsed.tabIndex}`,
      browser,
      windowIndex: parsed.windowIndex,
      tabIndex: parsed.tabIndex,
      url,
      title: title || "Untitled",
      isActive: parsed.isActive,
      domain: extractDomain(url),
    };
  });
}
