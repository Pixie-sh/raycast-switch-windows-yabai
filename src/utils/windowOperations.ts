interface SpaceLike {
  index: number;
  display: number;
  windows: unknown[];
  "is-native-fullscreen"?: boolean;
}

interface WindowLike {
  id: number;
  app?: string;
  title?: string;
  space?: number;
  display?: number;
  "is-native-fullscreen"?: boolean;
}

export interface AggregationPlan {
  matchingWindowIds: number[];
  targetDisplay: number;
  targetSpaceIndex?: number;
  needsCreate: boolean;
}

export interface DispersalPlan {
  spacesNeeded: number;
  assignments: Array<{ windowId: number; spaceIndex: number }>;
  focusSpaceIndex?: number;
}

export function getCreateSpaceArgs(display: number): string[] {
  if (!Number.isInteger(display) || display < 1) throw new Error(`Invalid display index: ${display}`);
  return ["-m", "space", "--create", String(display)];
}

export function isExpectedWindow(window: WindowLike, expectedApp: string, expectedTitle: string): boolean {
  return window.app?.toLowerCase() === expectedApp.toLowerCase() && window.title === expectedTitle;
}

export function isSameWindowIdentity(
  expected: Pick<WindowLike, "id" | "app" | "title">,
  live: Pick<WindowLike, "id" | "app" | "title">,
): boolean {
  return expected.id === live.id && isExpectedWindow(live, expected.app ?? "", expected.title ?? "");
}

export function assertSafeWindowCloseSupported(): never {
  throw new Error("Window close cannot be bound atomically to a yabai id through the macOS Accessibility API");
}

export function isUnsafeSpaceIndexMutationDisabled(): true {
  return true;
}

export function assertSafeSpaceDestructionSupported(): never {
  throw new Error("Space destruction cannot be made atomic with the available yabai command interface");
}

export function getEmptySpaceCandidates(spaces: SpaceLike[]): number[] {
  return spaces
    .filter((space) => Array.isArray(space.windows) && space.windows.length === 0)
    .map((space) => space.index)
    .sort((left, right) => right - left);
}

export function findCreatedSpace(before: SpaceLike[], after: SpaceLike[], display: number): SpaceLike | undefined {
  const previousIndices = new Set(before.filter((space) => space.display === display).map((space) => space.index));
  const createdSpaces = after.filter((space) => space.display === display && !previousIndices.has(space.index));
  return createdSpaces.length === 1 ? createdSpaces[0] : undefined;
}

export async function createSpaceOnDisplay<T extends SpaceLike>(
  display: number,
  querySpaces: () => Promise<T[]>,
  createSpace: (args: string[]) => Promise<unknown>,
): Promise<T> {
  const before = await querySpaces();
  await createSpace(getCreateSpaceArgs(display));
  const after = await querySpaces();
  const created = findCreatedSpace(before, after, display);
  if (!created) throw new Error(`Could not identify the new space on Display ${display}`);
  return created as T;
}

export function getAdjacentSpace(
  spaces: SpaceLike[],
  currentIndex: number,
  display: number,
  direction: "next" | "previous",
): number | undefined {
  const localIndices = spaces
    .filter((space) => space.display === display)
    .map((space) => space.index)
    .sort((a, b) => a - b);
  if (localIndices.length === 0) return undefined;
  const currentPosition = localIndices.indexOf(currentIndex);
  if (currentPosition < 0) return localIndices[0];
  const offset = direction === "next" ? 1 : -1;
  return localIndices[(currentPosition + offset + localIndices.length) % localIndices.length];
}

export function planAggregation(
  windows: WindowLike[],
  spaces: SpaceLike[],
  selectedWindow: WindowLike,
): AggregationPlan {
  if (!selectedWindow.display || !selectedWindow.app) {
    throw new Error("Selected window is missing display or application identity");
  }
  if (selectedWindow["is-native-fullscreen"] === true) {
    throw new Error("Native fullscreen windows cannot be aggregated safely");
  }
  const matchingWindowIds = windows
    .filter(
      (window) =>
        window.app?.toLowerCase() === selectedWindow.app?.toLowerCase() && window["is-native-fullscreen"] !== true,
    )
    .map((window) => window.id);
  const targetSpace = spaces
    .filter(
      (space) =>
        space.display === selectedWindow.display &&
        space.index !== selectedWindow.space &&
        space["is-native-fullscreen"] !== true &&
        Array.isArray(space.windows) &&
        space.windows.length === 0,
    )
    .sort((a, b) => a.index - b.index)[0];
  return {
    matchingWindowIds,
    targetDisplay: selectedWindow.display,
    targetSpaceIndex: targetSpace?.index,
    needsCreate: targetSpace === undefined,
  };
}

export function planDispersal(windows: WindowLike[], spaces: SpaceLike[], display: number): DispersalPlan {
  const eligibleWindows = windows.filter(
    (window) => window.display === display && window["is-native-fullscreen"] !== true,
  );
  const localSpaces = spaces
    .filter((space) => space.display === display && space["is-native-fullscreen"] !== true)
    .sort((a, b) => a.index - b.index);

  return {
    spacesNeeded: Math.max(0, eligibleWindows.length - localSpaces.length),
    assignments: eligibleWindows.slice(0, localSpaces.length).map((window, index) => ({
      windowId: window.id,
      spaceIndex: localSpaces[index].index,
    })),
    focusSpaceIndex: localSpaces[0]?.index,
  };
}
