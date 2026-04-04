# Bug Fix: Search Typo Tolerance and Search-Aware Default Selection

## Problem

The command mixed two different UX modes:

1. **Empty search** behaved like Alt+Tab, where the default selection should be the
   previously-focused window.
2. **Active search** should behave like a finder, where the default selection should move
   to the best visible match.

Two issues followed from that:

- Typo tolerance was inconsistent across result types. In particular, applications used a
  stricter Fuse threshold than windows, so inputs like `sal` could fail to find `Slack`
  even when `sla` worked.
- While typing, the highlighted row stayed pinned to the previous window because
  `selectedItemId` always pointed at the Alt+Tab default window instead of the first
  visible search result.

## Root Cause

The command implemented matching and selection separately inside
`src/switch-windows-yabai.tsx`.

- Windows, applications, and browser tabs each had their own search path.
- Window results were filtered by search first, but then re-sorted by focus history,
  which could undo the intended match ranking during active search.
- `selectedItemId` was always derived from the Alt+Tab window selection, so the selected
  row never switched into a search-first mode.

## Fix

### `src/utils/searchUtils.ts`

Added a shared search/selection helper layer:

- `searchItems(...)`
  - exact substring fast path
  - narrow adjacent-character-swap fallback for short queries
  - Fuse fallback
- `getDefaultSelectedItemId(...)`
  - preserves Alt+Tab behavior when search is empty
  - selects the first visible result when search is active

The adjacent-swap fallback is intentionally narrow so common transposition typos like
`sal` → `Slack` improve without broadly loosening Fuse thresholds and increasing noise.

### `src/switch-windows-yabai.tsx`

Rewired the command to use the shared helpers:

- Windows, applications, and tabs now use the same matching flow.
- Window results keep **focus-history sorting only when the search box is empty**.
- During active search, window results keep the **search-ranked order**.
- `selectedItemId` now switches between:
  - Alt+Tab default selection for empty search
  - first visible result for active search
- Applications now have stable item IDs, so they can participate in default selection the
  same way as windows and tabs.

### `test_search_behavior.mjs`

Added lightweight regression coverage for:

- `sal` → `Slack`
- Fuse fallback for non-transposition typos such as `slak`
- field-priority ordering
- empty-search vs active-search default selection behavior

## Key Invariants

After this change:

- **Empty search:** default selection remains the Alt+Tab target.
- **Active search:** default selection moves to the first visible result.
- **Active search on windows:** search ranking is preserved instead of being overwritten by
  focus-history sorting.
- **Typo tolerance:** short adjacent transposition mistakes can recover intended matches
  without globally loosening matching thresholds.

## Validation

Verified with:

- `npm run test:search`
- `npm run lint`
- `npm run build`
