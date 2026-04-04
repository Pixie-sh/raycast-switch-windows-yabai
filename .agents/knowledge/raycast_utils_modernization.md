# Raycast Utils Modernization (Feb 2026)

This document captures discoveries and decisions from the `@raycast/utils` upgrade and codebase cleanup pass.

---

## What Was Changed

### 1. `@raycast/utils` upgraded `^1.17.0` → `^2.2.2`

Run `npm install` after updating `package.json`.

### 2. `getApplications()` replaces custom `listApplications()`

- `getApplications()` is available from `@raycast/api`
- Returns objects with `.name` and `.path` — same shape as the local `Application` type
- Eliminates Node.js filesystem imports (`existsSync`, `readdir`, `path`)
- **Usage:** `const apps = await getApplications(); setApplications(apps.map(a => ({ name: a.name, path: a.path })));`

### 3. `getFavicon()` replaces hand-rolled `getFaviconUrl()`

- Import from `@raycast/utils`
- Returns `Image.ImageLike` directly (not a string)
- Replaces the entire `{ source: ..., fallback: ... }` icon object
- **Usage:** `getFavicon(tab.url, { fallback: getBrowserIcon(tab.browser) })`

### 4. `Keyboard.Shortcut.Common.Refresh` replaces hardcoded shortcut

- Import `Keyboard` from `@raycast/api`
- Replaces `{ modifiers: ["cmd", "ctrl"], key: "r" }`

### 5. `showFailureToast()` replaces verbose `showToast` failure calls

- Import `showFailureToast` from `@raycast/utils`
- For caught errors: `showFailureToast(error, { title: "..." })`
- For stderr strings: `showFailureToast(new Error(stderr.trim()), { title: "..." })`
- Replaced ~30 instances in `handlers.ts`

---

## Gotchas & Lessons Learned

### LSP errors are spurious in this environment

The LSP produces false positives like:

- `Property 'trim' does not exist on type 'string'`
- `Cannot find name 'Set'`
- `Type '[T, Dispatch<...>]' must have a '[Symbol.iterator]()'`

**These are not real errors.** The authoritative check is `npm run build` (esbuild via `ray build`).

### Multi-line template literal edits can leave orphaned code

When replacing large blocks containing multi-line template literals (e.g. `` `${foo}\n${bar}` ``), the `edit` tool sometimes inserts new content without removing the old content, creating duplicates. **Always read the affected region after such edits to verify.**

### Removing a variable used in JSX causes a runtime ReferenceError

Dead code removal (e.g. removing `isLoading` from state) must be accompanied by removing **all** JSX/JS references to that variable. The build (`ray build` / esbuild) does **not** catch this — it surfaces as a `ReferenceError` at runtime in `ray develop`. Always search for all usages before deleting a variable.

---

## What Was NOT Changed (intentional scope decisions)

- `useLocalStorage` hook — skipped; debounce behavior would need re-implementation, marginal benefit
- Browser Extension API — out of scope
- AI Tools — out of scope
- `captureException` — out of scope (YAGNI)
- Custom `appleScriptBridge.ts` (5MB buffer `runAppleScript`) — kept as-is
- `browserTabManager.ts`, `focusHistoryManager.ts`, `yabaiQueryManager.ts`, `displayFilter.ts` — no changes needed

---

## Files Affected

| File                           | Changes                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `package.json`                 | `@raycast/utils` version bump                                                                                          |
| `src/switch-windows-yabai.tsx` | `getApplications`, `getFavicon`, `Keyboard.Shortcut.Common.Refresh`, removed dead code, fixed orphaned `isLoading` ref |
| `src/handlers.ts`              | All `showToast` failure calls → `showFailureToast`                                                                     |

---

**Completed:** February 2026
