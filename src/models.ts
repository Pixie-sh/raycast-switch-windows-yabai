import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getPreferenceValues } from "@raycast/api";
import { COMMAND_ENV } from "./utils/command";

export interface Application {
  name: string;
  path: string;
}

export interface YabaiWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  space: number;
  frame?: { x: number; y: number; w: number; h: number };
  role?: string;
  subrole?: string;
  "root-window"?: boolean;
  display?: number;
  level?: number;
  focused?: boolean; // Legacy property for compatibility
  "has-focus"?: boolean; // Actual property from yabai
  "is-native-fullscreen"?: boolean;
}

export enum SortMethod {
  USAGE = "usage",
  RECENTLY_USED = "recently_used",
}

export interface YabaiSpace {
  index: number;
  windows: number[];
  display: number;
  "is-native-fullscreen"?: boolean;
}

export interface YabaiDisplay {
  id: number;
  uuid: string;
  index: number;
  label: string;
  frame: { x: number; y: number; w: number; h: number };
  spaces: number[];
  "has-focus": boolean;
}

export interface DisplayInfo {
  index: number;
  label: string;
  dimensions: string;
  isFocused: boolean;
}

/**
 * Supported browsers for tab search
 * Chromium-based browsers share similar AppleScript API
 */
export enum BrowserType {
  CHROME = "Google Chrome",
  VIVALDI = "Vivaldi",
  BRAVE = "Brave Browser",
  EDGE = "Microsoft Edge",
  ARC = "Arc",
  OPERA = "Opera",
  OPERA_GX = "Opera GX",
  SAFARI = "Safari",
  FIREFOX = "Firefox", // Limited support - window titles only
}

/**
 * Represents a browser tab that can be searched and focused
 */
export interface BrowserTab {
  /** Unique identifier: browser-windowIndex-tabIndex */
  id: string;
  /** Browser application name */
  browser: BrowserType;
  /** Browser window index (1-based) */
  windowIndex: number;
  /** Tab index within the window (1-based) */
  tabIndex: number;
  /** Full URL of the tab */
  url: string;
  /** Tab title */
  title: string;
  /** Whether this is the active tab in its window */
  isActive: boolean;
  /** Domain extracted from URL for display */
  domain: string;
}

/**
 * Focus history entry from yabai signal log
 */
export interface FocusHistoryEntry {
  /** Unix timestamp when window was focused */
  timestamp: number;
  /** Yabai window ID */
  windowId: number;
  /** Stable app/title identity when recorded by the extension. */
  fingerprint?: string;
}

interface Preferences {
  yabaiPath?: string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true);
  } catch {
    return false;
  }
}

function resolveYabaiPath(): string {
  const prefs = getPreferenceValues<Preferences>();
  if (prefs.yabaiPath) {
    if (!isExecutableFile(prefs.yabaiPath)) {
      throw new Error(`Configured yabai path is not an executable file: ${prefs.yabaiPath}`);
    }
    return prefs.yabaiPath;
  }

  const candidates = [
    "/opt/homebrew/bin/yabai",
    "/usr/local/bin/yabai",
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "yabai")),
  ];
  const detected = candidates.find(isExecutableFile);
  if (!detected) throw new Error("Could not find an executable yabai binary");
  return detected;
}

export const YABAI = resolveYabaiPath();

export const ENV: NodeJS.ProcessEnv = COMMAND_ENV;
