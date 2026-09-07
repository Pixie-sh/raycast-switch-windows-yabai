export interface RuntimeYabaiSpace {
  index: number;
  display: number;
  windows: unknown[];
  "is-native-fullscreen"?: boolean;
  [key: string]: unknown;
}

export interface RuntimeYabaiDisplay {
  id: number;
  uuid: string;
  index: number;
  label: string;
  frame: { x: number; y: number; w: number; h: number };
  spaces: number[];
  "has-focus": boolean;
  [key: string]: unknown;
}

export interface RuntimeYabaiWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  space: number;
  display?: number;
  [key: string]: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isYabaiWindow(value: unknown): value is RuntimeYabaiWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return (
    isPositiveInteger(window.id) &&
    isPositiveInteger(window.pid) &&
    typeof window.app === "string" &&
    typeof window.title === "string" &&
    isPositiveInteger(window.space) &&
    (window.display === undefined || isPositiveInteger(window.display))
  );
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFrame(value: unknown): value is RuntimeYabaiDisplay["frame"] {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return [frame.x, frame.y, frame.w, frame.h].every(isFiniteNumber);
}

function isYabaiSpace(value: unknown): value is RuntimeYabaiSpace {
  if (!value || typeof value !== "object") return false;
  const space = value as Record<string, unknown>;
  return (
    isPositiveInteger(space.index) &&
    isPositiveInteger(space.display) &&
    Array.isArray(space.windows) &&
    space.windows.every(isPositiveInteger) &&
    (space["is-native-fullscreen"] === undefined || typeof space["is-native-fullscreen"] === "boolean")
  );
}

function isYabaiDisplay(value: unknown): value is RuntimeYabaiDisplay {
  if (!value || typeof value !== "object") return false;
  const display = value as Record<string, unknown>;
  return (
    isPositiveInteger(display.id) &&
    typeof display.uuid === "string" &&
    isPositiveInteger(display.index) &&
    typeof display.label === "string" &&
    isFrame(display.frame) &&
    Array.isArray(display.spaces) &&
    display.spaces.every(isPositiveInteger) &&
    typeof display["has-focus"] === "boolean"
  );
}

export function parseYabaiWindow(raw: string): RuntimeYabaiWindow {
  const parsed = parseJson(raw, "yabai window");
  if (!isYabaiWindow(parsed)) throw new Error("Invalid yabai window data shape");
  return parsed;
}

export function parseYabaiSpaces(raw: string): RuntimeYabaiSpace[] {
  const parsed = parseJson(raw, "yabai spaces");
  if (!Array.isArray(parsed) || !parsed.every(isYabaiSpace)) throw new Error("Invalid yabai spaces data shape");
  return parsed;
}

export function parseYabaiSpace(raw: string): RuntimeYabaiSpace {
  const parsed = parseJson(raw, "yabai space");
  if (!isYabaiSpace(parsed)) throw new Error("Invalid yabai space data shape");
  return parsed;
}

export function parseYabaiDisplays(raw: string): RuntimeYabaiDisplay[] {
  const parsed = parseJson(raw, "yabai displays");
  if (!Array.isArray(parsed) || !parsed.every(isYabaiDisplay)) throw new Error("Invalid yabai displays data shape");
  return parsed;
}

export function parseYabaiDisplay(raw: string): RuntimeYabaiDisplay {
  const parsed = parseJson(raw, "yabai display");
  if (!isYabaiDisplay(parsed)) throw new Error("Invalid yabai display data shape");
  return parsed;
}

export function parseCachedWindows(raw: string, now: number, maxAgeMs: number): RuntimeYabaiWindow[] | null {
  try {
    const parsed = JSON.parse(raw) as { windows?: unknown; timestamp?: unknown };
    if (!isFiniteNumber(parsed.timestamp) || parsed.timestamp > now || now - parsed.timestamp > maxAgeMs) return null;
    if (!Array.isArray(parsed.windows) || !parsed.windows.every(isYabaiWindow)) return null;
    return parsed.windows;
  } catch {
    return null;
  }
}

export function parseYabaiWindows(raw: string): RuntimeYabaiWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid yabai windows JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isYabaiWindow)) {
    throw new Error("Invalid yabai windows data shape");
  }
  return parsed;
}
