/**
 * AppleScript Bridge - Generic utilities for executing AppleScript commands
 * Used for browser tab access and other macOS automation
 */

import { exec } from "child_process";
import { promisify } from "util";
import { ENV } from "../models";

const execAsync = promisify(exec);

/**
 * Execute an AppleScript and return the result
 * @param script - AppleScript code to execute
 * @returns The stdout from osascript
 * @throws AppleScriptError on execution failure
 */
export async function runAppleScript(script: string): Promise<string> {
  try {
    // Use -ss flag for strict error handling
    const { stdout, stderr } = await execAsync(`osascript -e '${escapeAppleScript(script)}'`, {
      env: ENV,
      maxBuffer: 5 * 1024 * 1024, // 5MB buffer for large tab lists
      timeout: 10000, // 10 second timeout
    });

    if (stderr?.trim()) {
      console.warn("AppleScript stderr:", stderr);
    }

    return stdout.trim();
  } catch (error) {
    throw new AppleScriptError(error instanceof Error ? error.message : "Unknown AppleScript error", script, error);
  }
}

/**
 * Execute AppleScript that returns a list/array result
 * Parses the AppleScript list format into JavaScript array
 */
export async function runAppleScriptList(script: string): Promise<string[]> {
  const result = await runAppleScript(script);
  if (!result) return [];

  // AppleScript returns lists as comma-separated values
  // Handle nested lists and special characters
  return parseAppleScriptList(result);
}

/**
 * Escape single quotes and other special characters for shell execution
 */
function escapeAppleScript(script: string): string {
  // Replace single quotes with escaped version for shell
  return script.replace(/'/g, "'\"'\"'");
}

/**
 * Parse AppleScript list output into array
 * Handles format: "item1, item2, item3" or "{item1, item2}"
 */
function parseAppleScriptList(output: string): string[] {
  // Remove surrounding braces if present
  let cleaned = output.trim();
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    cleaned = cleaned.slice(1, -1);
  }

  // Split by comma, handling quoted strings
  const items: string[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;

  for (const char of cleaned) {
    if (char === '"' && depth === 0) {
      inQuotes = !inQuotes;
    } else if (char === "{") {
      depth++;
      current += char;
    } else if (char === "}") {
      depth--;
      current += char;
    } else if (char === "," && !inQuotes && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

/**
 * Custom error class for AppleScript failures
 */
export class AppleScriptError extends Error {
  public readonly script: string;
  public readonly originalError: unknown;

  constructor(message: string, script: string, originalError?: unknown) {
    super(message);
    this.name = "AppleScriptError";
    this.script = script;
    this.originalError = originalError;
  }

  /**
   * Check if error is due to missing Automation permissions
   */
  isPermissionError(): boolean {
    const msg = this.message.toLowerCase();
    return (
      msg.includes("not authorized") ||
      msg.includes("-1743") ||
      msg.includes("permission") ||
      msg.includes("not allowed")
    );
  }

  /**
   * Check if error is because the target application is not running
   */
  isAppNotRunning(): boolean {
    const msg = this.message.toLowerCase();
    return (
      msg.includes("not running") || msg.includes("can't get application") || msg.includes("connection is invalid")
    );
  }
}

/**
 * Check if an error is an AppleScript permission error
 */
export function isAppleScriptPermissionError(error: unknown): boolean {
  if (error instanceof AppleScriptError) {
    return error.isPermissionError();
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("not authorized") || msg.includes("-1743");
  }
  return false;
}

/**
 * Check if an error indicates the browser is not running
 */
export function isBrowserNotRunning(error: unknown): boolean {
  if (error instanceof AppleScriptError) {
    return error.isAppNotRunning();
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("not running") || msg.includes("can't get application");
  }
  return false;
}

/**
 * Get list of running applications via AppleScript
 */
export async function getRunningApplications(): Promise<string[]> {
  try {
    const script = `tell application "System Events" to get name of every process whose background only is false`;
    const result = await runAppleScript(script);
    return result.split(", ").map((name) => name.trim());
  } catch (error) {
    console.error("Failed to get running applications:", error);
    return [];
  }
}
