# Knowledge Base

This directory contains accumulated knowledge and patterns from building and optimizing the Raycast Switch Windows (yabai) extension.

## 📚 Documents

### Core Patterns
- **[performance_patterns.md](./performance_patterns.md)** - Performance optimization patterns, caching strategies, and best practices
- **[react_raycast_patterns.md](./react_raycast_patterns.md)** - React hooks patterns, Raycast API conventions, and component optimization
- **[typo-tolerant-search-selection.md](./typo-tolerant-search-selection.md)** - Search ranking, typo-tolerant matching, and search-aware default selection behavior

### Integration Guides  
- **[yabai_integration.md](./yabai_integration.md)** - Yabai integration patterns and external process management
- **[window_management.md](./window_management.md)** - Window management strategies and behaviors
- **[browser_tab_search.md](./browser_tab_search.md)** - Browser tab search via AppleScript and focus tracking with yabai signals

### Standards
- **[typescript_standards.md](./typescript_standards.md)** - TypeScript coding standards and conventions
- **[testing_strategy.md](./testing_strategy.md)** - Testing approaches and strategies

## 🎯 Quick Start

If you're new to the codebase, read in this order:

1. **typescript_standards.md** - Understand coding conventions
2. **react_raycast_patterns.md** - Learn React/Raycast patterns
3. **performance_patterns.md** - Apply performance best practices
4. **yabai_integration.md** - Integrate with yabai
5. **browser_tab_search.md** - Browser tabs & focus tracking
6. **typo-tolerant-search-selection.md** - Search behavior and selection invariants

## 🔥 Recent Updates (Nov 2024)

### Major Performance Improvements
- **Eliminated crashes** by removing Web Worker implementation (not supported in Raycast)
- **Fixed memory leaks** with proper useEffect cleanup
- **70% faster startup** with async file operations
- **70% faster search** with cached Fuse.js instances
- **80% less I/O** with debounced LocalStorage writes

See `../PERFORMANCE_FIXES.md` for detailed changelog.

## 💡 Key Learnings

### What Doesn't Work in Raycast
- ❌ Web Workers (will crash)
- ❌ DOM APIs (no window/document)
- ❌ Synchronous file I/O (blocks UI)
- ❌ Browser localStorage (use `@raycast/api` LocalStorage)
- ❌ Delegating to Raycast root search (see [raycast_api_limitations.md](./raycast_api_limitations.md))

### What Works Great
- ✅ Async operations with proper cleanup
- ✅ Cached computations (Map/useMemo/useRef)
- ✅ Debounced state updates
- ✅ External process calls (exec/execFile)
- ✅ Fuzzy search with Fuse.js

### Performance Principles
1. Cache expensive operations (Fuse instances, parsed data)
2. Debounce I/O operations (storage, external processes)
3. Use async for file operations
4. Clean up all timers/intervals/promises
5. Limit cache sizes to prevent memory leaks

## 🛠️ Contributing to Knowledge Base

When you learn something new or solve a problem:

1. Document the **problem** clearly
2. Show the **wrong way** (❌) and **right way** (✅)
3. Explain the **impact** (performance, correctness, etc.)
4. Add **code examples** with comments
5. Update this README if adding new documents

## 📊 Metrics That Matter

- Extension startup time: Target < 200ms
- Search response: Target < 50ms  
- Memory growth: Should be stable (no leaks)
- Build time: ~2-3 seconds
- Bundle size: Keep under 1MB

## 🔗 Related Files

- `../PERFORMANCE_FIXES.md` - Detailed performance fix history
- `../src/utils/` - Utility implementations
- `../src/switch-windows-yabai.tsx` - Main component showing patterns in practice

---

**Last Updated:** January 2026  
**Status:** Active development, well-optimized
