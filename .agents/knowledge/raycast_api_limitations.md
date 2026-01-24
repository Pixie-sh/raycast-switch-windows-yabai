# Raycast API Limitations

This document captures limitations discovered while attempting to integrate with Raycast's built-in functionality.

## Delegating Search to Raycast Root

### Problem
We wanted to remove the custom applications search and delegate to Raycast's built-in search, showing a "fallback" option that would seamlessly transition to Raycast root search with the current search text preserved.

### What We Tried
1. **`popToRoot({ clearSearchBar: false })`** - Pops navigation to root but:
   - Requires user action (Enter key) to trigger
   - Cannot be triggered automatically/inline
   - Search text is NOT preserved in Raycast root (the option is misleading)

2. **Deeplinks with `fallbackText`** - Format: `raycast://extensions/author/ext/cmd?fallbackText=text`
   - Only works for launching specific extension commands
   - No deeplink exists to open Raycast root search with pre-filled text
   - `fallbackText` parameter only prefills the search bar of the target command, not root search

3. **`launchCommand` API** - Can launch other extension commands but:
   - Cannot launch Raycast's built-in root search
   - Requires knowing the exact extension/command to launch

### Conclusion
❌ **There is NO way to:**
- Render Raycast's root search results inline within an extension
- Automatically navigate to root search without user action
- Pre-fill Raycast root search with a query from an extension
- Embed or delegate to Raycast's built-in app/file search

✅ **What IS possible:**
- `popToRoot()` to return to root search (user must re-type query)
- Deeplinks to specific extension commands with `fallbackText`
- Launching other extension commands via `launchCommand`

### Recommendation
If you need application search, implement it within your extension rather than trying to delegate to Raycast. The custom implementation provides:
- Better control over search behavior
- Consistent UX within your extension
- No navigation interruption

### API References
- [popToRoot](https://developers.raycast.com/api-reference/window-and-search-bar#poptoroot)
- [Deeplinks](https://developers.raycast.com/information/lifecycle/deeplinks)
- [launchCommand](https://developers.raycast.com/api-reference/command#launchcommand)

---

**Discovered:** January 2026
**Context:** Attempted to make extension lighter by delegating app search to Raycast
