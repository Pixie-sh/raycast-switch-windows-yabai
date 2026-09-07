export type SearchScope = "all" | "windows" | "applications" | "tabs";

export function shouldShowWebFallbackForScope(
  scope: SearchScope,
  hasTabOnlyPrefix: boolean,
  hasDisplayOnlyPrefix: boolean,
): boolean {
  return scope === "all" && !hasTabOnlyPrefix && !hasDisplayOnlyPrefix;
}
