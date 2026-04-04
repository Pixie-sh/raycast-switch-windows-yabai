import Fuse from "fuse.js";

const MIN_ADJACENT_SWAP_QUERY_LENGTH = 3;
const MAX_ADJACENT_SWAP_QUERY_LENGTH = 4;

export interface SearchField<T> {
  getValue: (item: T) => string | null | undefined;
  priority: number;
}

interface RankedMatch<T> {
  item: T;
  priority: number;
  exactEquality: boolean;
  fieldLength: number;
  originalIndex: number;
}

export interface SearchItemsOptions<T> {
  items: T[];
  query: string;
  fields: SearchField<T>[];
  fuse: Fuse<T> | null;
}

export interface DefaultSelectionOptions {
  hasSearchText: boolean;
  emptySearchItemId?: string;
  visibleItemIds: string[];
}

/**
 * Normalize search text for exact and typo-tolerant matching.
 */
export function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Build adjacent-character swap variants for short queries.
 * This is intentionally narrow so common transposition typos improve
 * without broadly increasing fuzzy-search noise.
 */
export function getAdjacentSwapVariants(query: string): string[] {
  const normalizedQuery = normalizeSearchValue(query);

  if (
    normalizedQuery.length < MIN_ADJACENT_SWAP_QUERY_LENGTH ||
    normalizedQuery.length > MAX_ADJACENT_SWAP_QUERY_LENGTH
  ) {
    return [];
  }

  const variants = new Set<string>();

  for (let index = 0; index < normalizedQuery.length - 1; index += 1) {
    const chars = normalizedQuery.split("");
    [chars[index], chars[index + 1]] = [chars[index + 1], chars[index]];
    const variant = chars.join("");
    if (variant !== normalizedQuery) {
      variants.add(variant);
    }
  }

  return [...variants];
}

/**
 * Search items using an exact fast path, a narrow typo-tolerant fallback,
 * and Fuse.js as the final fuzzy-search fallback.
 */
export function searchItems<T>({ items, query, fields, fuse }: SearchItemsOptions<T>): T[] {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) {
    return items;
  }

  const exactMatches = getRankedMatches(items, fields, [normalizedQuery]);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const adjacentSwapMatches = getRankedMatches(items, fields, getAdjacentSwapVariants(normalizedQuery));
  if (adjacentSwapMatches.length > 0) {
    return adjacentSwapMatches;
  }

  if (!fuse) {
    return [];
  }

  return fuse.search(normalizedQuery).map((result) => result.item);
}

/**
 * Resolve the default selected item. Empty search preserves Alt+Tab behavior,
 * while active search selects the first currently visible result.
 */
export function getDefaultSelectedItemId({
  hasSearchText,
  emptySearchItemId,
  visibleItemIds,
}: DefaultSelectionOptions): string | undefined {
  if (!hasSearchText) {
    return emptySearchItemId;
  }

  return visibleItemIds[0];
}

function getRankedMatches<T>(items: T[], fields: SearchField<T>[], terms: string[]): T[] {
  if (terms.length === 0) {
    return [];
  }

  const rankedMatches = items
    .map((item, originalIndex) => getBestMatch(item, originalIndex, fields, terms))
    .filter((match): match is RankedMatch<T> => match !== null)
    .sort(compareRankedMatches);

  return rankedMatches.map((match) => match.item);
}

function getBestMatch<T>(
  item: T,
  originalIndex: number,
  fields: SearchField<T>[],
  terms: string[],
): RankedMatch<T> | null {
  let bestMatch: RankedMatch<T> | null = null;

  for (const field of fields) {
    const normalizedFieldValue = normalizeSearchValue(field.getValue(item) ?? "");
    if (!normalizedFieldValue) {
      continue;
    }

    for (const term of terms) {
      if (!term || !normalizedFieldValue.includes(term)) {
        continue;
      }

      const candidate: RankedMatch<T> = {
        item,
        priority: field.priority,
        exactEquality: normalizedFieldValue === term,
        fieldLength: normalizedFieldValue.length,
        originalIndex,
      };

      if (bestMatch === null || compareRankedMatches(candidate, bestMatch) < 0) {
        bestMatch = candidate;
      }
    }
  }

  return bestMatch;
}

function compareRankedMatches<T>(left: RankedMatch<T>, right: RankedMatch<T>): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  if (left.exactEquality !== right.exactEquality) {
    return left.exactEquality ? -1 : 1;
  }

  if (left.fieldLength !== right.fieldLength) {
    return left.fieldLength - right.fieldLength;
  }

  return left.originalIndex - right.originalIndex;
}
