interface WindowIdentity {
  id: number;
  app: string;
  title: string;
  display?: number;
  space: number;
  focused?: boolean;
  "has-focus"?: boolean;
}

export interface UsageEntry {
  count: number;
  lastUsed: number;
}

export interface UsageStorage {
  version: 2;
  entries: Record<string, UsageEntry>;
}

const LEGACY_USAGE_PREFIX = "legacy-id:";
const LEGACY_APP_PREFIX = "legacy-app:";

export function parseUsageStorage(raw: string | undefined): Record<string, UsageEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> & { version?: unknown; entries?: unknown };
    if (parsed.version === 2 && parsed.entries && typeof parsed.entries === "object") {
      return Object.fromEntries(
        Object.entries(parsed.entries as Record<string, unknown>).filter(([, value]) => {
          if (!value || typeof value !== "object") return false;
          const entry = value as Record<string, unknown>;
          return typeof entry.count === "number" && entry.count >= 0 && typeof entry.lastUsed === "number";
        }),
      ) as Record<string, UsageEntry>;
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([windowId, value]) => {
        if (!/^\d+$/.test(windowId) || typeof value !== "number" || !Number.isFinite(value)) return [];
        return [[`${LEGACY_USAGE_PREFIX}${windowId}`, { count: 1, lastUsed: value }]];
      }),
    );
  } catch {
    return {};
  }
}

export function serializeUsageStorage(entries: Record<string, UsageEntry>): string {
  return JSON.stringify({ version: 2, entries } satisfies UsageStorage);
}

export function migrateLegacyUsage(
  usage: Record<string, UsageEntry>,
  windows: WindowIdentity[],
): Record<string, UsageEntry> {
  void windows;
  // Legacy usage contains no app/title identity. Preserve it, but never apply
  // it to a potentially recycled live window ID.
  return { ...usage };
}

export function recordWindowUsage(
  usage: Record<string, UsageEntry>,
  window: Pick<WindowIdentity, "id" | "app" | "title">,
  timestamp: number,
): Record<string, UsageEntry> {
  const key = getWindowIdUsageKey(window);
  const previous = usage[key] ?? { count: 0, lastUsed: 0 };
  return { ...usage, [key]: { count: previous.count + 1, lastUsed: timestamp } };
}

export function getWindowFingerprint(window: Pick<WindowIdentity, "app" | "title">): string {
  return `${window.app.trim().toLowerCase()}\u001f${window.title.trim().toLowerCase()}`;
}

export function getWindowIdUsageKey(window: Pick<WindowIdentity, "id" | "app" | "title">): string {
  return `window-id:${window.id}\u001f${getWindowFingerprint(window)}`;
}

export interface FocusReference {
  id: number;
  fingerprint: string;
}

export interface FocusState {
  current: FocusReference | null;
  previous: FocusReference | null;
}

function isFocusReference(value: unknown): value is FocusReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return (
    Number.isInteger(reference.id) &&
    Number(reference.id) > 0 &&
    typeof reference.fingerprint === "string" &&
    reference.fingerprint.length > 0
  );
}

export function parseFocusState(raw: string | undefined): FocusState {
  const empty: FocusState = { current: null, previous: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      current?: unknown;
      currentApp?: unknown;
      previous?: unknown;
      previousApp?: unknown;
    };
    if (parsed.version === 2) {
      return {
        current: isFocusReference(parsed.current) ? parsed.current : null,
        previous: isFocusReference(parsed.previous) ? parsed.previous : null,
      };
    }
    const toLegacyReference = (id: unknown, app: unknown): FocusReference | null =>
      Number.isInteger(id) && Number(id) > 0 && typeof app === "string" && app.trim().length > 0
        ? { id: Number(id), fingerprint: `${LEGACY_APP_PREFIX}${app.trim().toLowerCase()}` }
        : null;
    return {
      current: toLegacyReference(parsed.current, parsed.currentApp),
      previous: toLegacyReference(parsed.previous, parsed.previousApp),
    };
  } catch {
    return empty;
  }
}

export function serializeFocusState(state: FocusState): string {
  return JSON.stringify({ version: 2, ...state });
}

export function makeFocusReference(window: WindowIdentity): FocusReference {
  return { id: window.id, fingerprint: getWindowFingerprint(window) };
}

export function resolveFocusReference<T extends WindowIdentity>(
  reference: FocusReference | null | undefined,
  windows: T[],
): T | undefined {
  if (!reference) return undefined;
  if (reference.fingerprint.startsWith(LEGACY_APP_PREFIX)) return undefined;
  const sameId = windows.find((window) => window.id === reference.id);
  return sameId && getWindowFingerprint(sameId) === reference.fingerprint ? sameId : undefined;
}

export function advanceFocusState(state: FocusState, next: FocusReference): FocusState {
  if (state.current?.id === next.id && state.current.fingerprint === next.fingerprint) return state;
  return { current: next, previous: state.current };
}

export function migrateFocusState<T extends WindowIdentity>(state: FocusState, windows: T[]): FocusState {
  const migrate = (reference: FocusReference | null): FocusReference | null => {
    const resolved = resolveFocusReference(reference, windows);
    return resolved ? makeFocusReference(resolved) : reference;
  };
  return { current: migrate(state.current), previous: migrate(state.previous) };
}

export function sortWindows<T extends WindowIdentity>(
  windows: T[],
  method: "recently_used" | "usage",
  usage: Record<string, UsageEntry>,
  recentTimes: Record<number, number>,
): T[] {
  const getUsage = (window: T): UsageEntry => usage[getWindowIdUsageKey(window)] ?? { count: 0, lastUsed: 0 };

  return [...windows].sort((left, right) => {
    const leftFocused = left["has-focus"] === true || left.focused === true;
    const rightFocused = right["has-focus"] === true || right.focused === true;
    if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
    const leftUsage = getUsage(left);
    const rightUsage = getUsage(right);
    if (method === "usage" && leftUsage.count !== rightUsage.count) return rightUsage.count - leftUsage.count;
    const leftTime = method === "usage" ? leftUsage.lastUsed : (recentTimes[left.id] ?? leftUsage.lastUsed);
    const rightTime = method === "usage" ? rightUsage.lastUsed : (recentTimes[right.id] ?? rightUsage.lastUsed);
    return rightTime - leftTime;
  });
}

export function getWindowSetKey(windows: WindowIdentity[]): string {
  return windows
    .map((window) => [window.id, window.app, window.title, window.display ?? "", window.space].join("\u001f"))
    .join("\u001e");
}

export function getCycledIndex(currentIndex: number, itemCount: number, direction: "next" | "previous"): number {
  if (itemCount <= 0) return 0;
  const offset = direction === "next" ? 1 : -1;
  return (currentIndex + offset + itemCount) % itemCount;
}

export function getCycleOriginForSelection(
  selectedItemId: string | undefined,
  orderedWindowItemIds: string[],
  fallbackIndex: number,
): number {
  const index = selectedItemId ? orderedWindowItemIds.indexOf(selectedItemId) : -1;
  return index >= 0 ? index : fallbackIndex;
}

export function resolveCountdownTarget<T extends WindowIdentity>(
  captured: FocusReference,
  selectedItemId: string | undefined,
  windows: T[],
): T | undefined {
  if (selectedItemId !== `window-${captured.id}`) return undefined;
  return resolveFocusReference(captured, windows);
}

export async function hydrateWindowState(
  getItem: (key: string) => Promise<string | undefined>,
): Promise<{ usageTimes: Record<string, UsageEntry>; focusHistory: FocusState; error: Error | null }> {
  try {
    const [storedTimes, storedFocusHistory] = await Promise.all([getItem("usageTimes"), getItem("focusHistory")]);
    return {
      usageTimes: parseUsageStorage(storedTimes),
      focusHistory: parseFocusState(storedFocusHistory),
      error: null,
    };
  } catch (error) {
    return {
      usageTimes: {},
      focusHistory: { current: null, previous: null },
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function shouldSyncFocusHistory(isHydrated: boolean, hasFreshWindowData: boolean): boolean {
  return isHydrated && hasFreshWindowData;
}

export function resolveSelectedWindow<T extends Pick<WindowIdentity, "id">>(
  selectedItemId: string | undefined,
  windows: T[],
): T | undefined {
  const match = /^window-(\d+)$/.exec(selectedItemId ?? "");
  if (!match) return undefined;
  const id = Number(match[1]);
  return windows.find((window) => window.id === id);
}

export function resolveVisibleSelection(
  userSelectedId: string | undefined,
  visibleItemIds: string[],
  defaultItemId: string | undefined,
): string | undefined {
  if (userSelectedId && visibleItemIds.includes(userSelectedId)) return userSelectedId;
  if (defaultItemId && visibleItemIds.includes(defaultItemId)) return defaultItemId;
  return visibleItemIds[0];
}
