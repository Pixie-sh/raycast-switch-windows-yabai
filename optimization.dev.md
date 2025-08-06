# Performance Optimization Implementation Guide

This document provides specific implementation strategies to address the critical performance bottlenecks identified in the Raycast Switch Windows Yabai extension.

---

## 1. Async Application Loading

### **Current Issue**
The `listApplications()` function performs synchronous filesystem operations (existsSync, readdirSync) that block the main thread for 50-500ms on every component mount.

### **Implementation Strategy**
Convert to async operations with background refresh and caching layer.

### **Code Implementation**

```typescript
// src/hooks/useAsyncApplications.ts
import { promises as fs } from 'fs';
import { useState, useEffect, useRef } from 'react';

interface ApplicationCache {
  data: Application[];
  timestamp: number;
  isStale: boolean;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const APP_DIRECTORIES = [
  '/Applications',
  '/System/Applications',
  '~/Applications',
  '/System/Library/CoreServices/Applications'
];

export function useAsyncApplications() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const cacheRef = useRef<ApplicationCache | null>(null);
  const abortControllerRef = useRef<AbortController>();

  const loadApplicationsAsync = async (forceRefresh = false): Promise<Application[]> => {
    // Check cache first
    if (!forceRefresh && cacheRef.current && !cacheRef.current.isStale) {
      return cacheRef.current.data;
    }

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;

    try {
      setIsLoading(true);
      const apps: Application[] = [];

      // Process directories in parallel
      const directoryPromises = APP_DIRECTORIES.map(async (dir) => {
        try {
          const expandedDir = dir.replace('~', process.env.HOME || '');
          await fs.access(expandedDir); // Check if directory exists
          
          if (signal.aborted) return [];

          const files = await fs.readdir(expandedDir);
          
          return files
            .filter(file => file.endsWith('.app'))
            .map(file => ({
              name: file.replace('.app', ''),
              path: `${expandedDir}/${file}`
            }));
        } catch {
          return []; // Directory doesn't exist or no access
        }
      });

      const results = await Promise.allSettled(directoryPromises);
      
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          apps.push(...result.value);
        }
      });

      if (!signal.aborted) {
        // Update cache
        cacheRef.current = {
          data: apps,
          timestamp: Date.now(),
          isStale: false
        };

        setApplications(apps);
        return apps;
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error('Failed to load applications:', error);
      }
    } finally {
      if (!signal.aborted) {
        setIsLoading(false);
      }
    }

    return cacheRef.current?.data || [];
  };

  // Background refresh
  useEffect(() => {
    loadApplicationsAsync();

    // Set up background refresh
    const interval = setInterval(() => {
      if (cacheRef.current) {
        cacheRef.current.isStale = Date.now() - cacheRef.current.timestamp > CACHE_TTL;
        if (cacheRef.current.isStale) {
          loadApplicationsAsync();
        }
      }
    }, CACHE_TTL);

    return () => {
      clearInterval(interval);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    applications,
    isLoading,
    refresh: () => loadApplicationsAsync(true)
  };
}
```

### **Integration Example**
```typescript
// src/switch-windows-yabai.tsx
import { useAsyncApplications } from './hooks/useAsyncApplications';

export default function SwitchWindowsYabai(props: LaunchProps) {
  const { applications, isLoading: appsLoading, refresh: refreshApps } = useAsyncApplications();
  
  // Replace the synchronous listApplications() call
  // const applications = listApplications(); // Remove this line
  
  // Use the async applications data
  const applicationsFuse = useMemo(() => {
    return new Fuse(applications, {
      keys: [{ name: "name", weight: 1 }],
      threshold: 0.4,
      ignoreLocation: true,
    });
  }, [applications]);
}
```

---

## 2. Yabai Query Consolidation

### **Current Issue**
Multiple components independently query yabai, causing redundant process executions and race conditions.

### **Implementation Strategy**
Implement a centralized query manager with request deduplication and shared state.

### **Code Implementation**

```typescript
// src/hooks/useYabaiQuery.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import { useState, useEffect, useCallback, useRef } from 'react';

const execAsync = promisify(exec);

interface QueryCache<T> {
  data: T | null;
  timestamp: number;
  promise: Promise<T> | null;
  error: Error | null;
}

interface YabaiQueryManager {
  windows: QueryCache<YabaiWindow[]>;
  displays: QueryCache<YabaiDisplay[]>;
  spaces: QueryCache<YabaiSpace[]>;
}

class YabaiQueryService {
  private cache: YabaiQueryManager = {
    windows: { data: null, timestamp: 0, promise: null, error: null },
    displays: { data: null, timestamp: 0, promise: null, error: null },
    spaces: { data: null, timestamp: 0, promise: null, error: null }
  };

  private readonly CACHE_TTL = 2000; // 2 seconds for yabai queries
  private readonly ENV = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
  private readonly YABAI_PATH = '/opt/homebrew/bin/yabai';

  async query<T>(
    type: keyof YabaiQueryManager,
    command: string,
    parser: (stdout: string) => T
  ): Promise<T> {
    const cacheEntry = this.cache[type] as QueryCache<T>;
    const now = Date.now();

    // Return cached data if still fresh
    if (cacheEntry.data && (now - cacheEntry.timestamp) < this.CACHE_TTL) {
      return cacheEntry.data;
    }

    // Return existing promise if query is in flight
    if (cacheEntry.promise) {
      return cacheEntry.promise;
    }

    // Execute new query
    cacheEntry.promise = this.executeQuery(command, parser);

    try {
      const result = await cacheEntry.promise;
      cacheEntry.data = result;
      cacheEntry.timestamp = now;
      cacheEntry.error = null;
      return result;
    } catch (error) {
      cacheEntry.error = error as Error;
      throw error;
    } finally {
      cacheEntry.promise = null;
    }
  }

  private async executeQuery<T>(command: string, parser: (stdout: string) => T): Promise<T> {
    try {
      const { stdout } = await execAsync(`${this.YABAI_PATH} ${command}`, {
        env: this.ENV,
        timeout: 5000
      });
      return parser(stdout.trim());
    } catch (error) {
      console.error(`Yabai query failed: ${command}`, error);
      throw error;
    }
  }

  // Invalidate cache for specific query type
  invalidate(type: keyof YabaiQueryManager) {
    this.cache[type].data = null;
    this.cache[type].timestamp = 0;
  }

  // Invalidate all caches
  invalidateAll() {
    Object.keys(this.cache).forEach(key => {
      this.invalidate(key as keyof YabaiQueryManager);
    });
  }
}

// Singleton instance
const yabaiQueryService = new YabaiQueryService();

// Hook for consuming yabai data
export function useYabaiQuery<T>(
  type: keyof YabaiQueryManager,
  command: string,
  parser: (stdout: string) => T,
  options: { refreshInterval?: number; enabled?: boolean } = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  const { refreshInterval = 0, enabled = true } = options;
  const intervalRef = useRef<NodeJS.Timeout>();

  const executeQuery = useCallback(async () => {
    if (!enabled) return;

    try {
      setIsLoading(true);
      setError(null);
      const result = await yabaiQueryService.query(type, command, parser);
      setData(result);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [type, command, parser, enabled]);

  const invalidateQuery = useCallback(() => {
    yabaiQueryService.invalidate(type);
  }, [type]);

  useEffect(() => {
    executeQuery();

    if (refreshInterval > 0) {
      intervalRef.current = setInterval(executeQuery, refreshInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [executeQuery, refreshInterval]);

  return {
    data,
    isLoading,
    error,
    refetch: executeQuery,
    invalidate: invalidateQuery
  };
}

// Specific hooks for different yabai queries
export function useYabaiWindows(options?: { refreshInterval?: number; enabled?: boolean }) {
  return useYabaiQuery(
    'windows',
    '-m query --windows',
    (stdout) => JSON.parse(stdout) as YabaiWindow[],
    options
  );
}

export function useYabaiDisplays(options?: { refreshInterval?: number; enabled?: boolean }) {
  return useYabaiQuery(
    'displays',
    '-m query --displays',
    (stdout) => JSON.parse(stdout) as YabaiDisplay[],
    options
  );
}

export function useYabaiSpaces(options?: { refreshInterval?: number; enabled?: boolean }) {
  return useYabaiQuery(
    'spaces',
    '-m query --spaces',
    (stdout) => JSON.parse(stdout) as YabaiSpace[],
    options
  );
}
```

### **Integration Example**
```typescript
// src/switch-windows-yabai.tsx
import { useYabaiWindows } from './hooks/useYabaiQuery';

export default function SwitchWindowsYabai(props: LaunchProps) {
  const { data: windows, isLoading, error, refetch, invalidate } = useYabaiWindows({
    refreshInterval: 5 * 60 * 1000, // 5 minutes
    enabled: true
  });

  // Remove the duplicate useExec and refreshWindows logic
  // const { isLoading, data, error } = useExec<YabaiWindow[]>(...); // Remove
  // const refreshWindows = useCallback(...); // Remove

  // Use the consolidated data
  const filteredWindows = useMemo(() => {
    if (!windows) return [];
    return windows.filter(window => window.title && window.app);
  }, [windows]);
}
```

---

## 3. Smart Caching Strategy

### **Current Issue**
Fixed 5-minute cache TTL doesn't account for user activity patterns, and cache writes happen on every update.

### **Implementation Strategy**
Implement adaptive cache TTL based on user activity with intelligent invalidation.

### **Code Implementation**

```typescript
// src/utils/smartCache.ts
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  ttl: number;
}

interface UserActivity {
  lastInteraction: number;
  interactionFrequency: number;
  isActive: boolean;
}

export class SmartCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private userActivity: UserActivity = {
    lastInteraction: Date.now(),
    interactionFrequency: 0,
    isActive: true
  };

  private readonly BASE_TTL = 2 * 60 * 1000; // 2 minutes base
  private readonly MAX_TTL = 15 * 60 * 1000; // 15 minutes max
  private readonly MIN_TTL = 30 * 1000; // 30 seconds min

  constructor() {
    this.setupActivityTracking();
  }

  private setupActivityTracking() {
    // Track user interactions
    const trackActivity = () => {
      const now = Date.now();
      const timeSinceLastInteraction = now - this.userActivity.lastInteraction;
      
      // Calculate interaction frequency (interactions per minute)
      this.userActivity.interactionFrequency = 
        timeSinceLastInteraction > 60000 ? 0 : this.userActivity.interactionFrequency + 1;
      
      this.userActivity.lastInteraction = now;
      this.userActivity.isActive = timeSinceLastInteraction < 30000; // Active if interaction within 30s
    };

    // Track various user activities
    document.addEventListener('keydown', trackActivity);
    document.addEventListener('click', trackActivity);
    window.addEventListener('focus', trackActivity);
  }

  private calculateAdaptiveTTL(): number {
    const { isActive, interactionFrequency } = this.userActivity;
    
    if (isActive && interactionFrequency > 5) {
      // High activity: shorter TTL for fresh data
      return this.MIN_TTL;
    } else if (isActive) {
      // Moderate activity: base TTL
      return this.BASE_TTL;
    } else {
      // Low activity: longer TTL to reduce resource usage
      return this.MAX_TTL;
    }
  }

  set(key: string, data: T, customTTL?: number): void {
    const now = Date.now();
    const ttl = customTTL || this.calculateAdaptiveTTL();

    this.cache.set(key, {
      data,
      timestamp: now,
      accessCount: 0,
      lastAccessed: now,
      ttl
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const isExpired = (now - entry.timestamp) > entry.ttl;

    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    // Update access tracking
    entry.accessCount++;
    entry.lastAccessed = now;

    return entry.data;
  }

  // Incremental update for arrays
  updateIncremental<K extends keyof T>(
    key: string, 
    updates: Partial<T>, 
    mergeFn?: (existing: T, updates: Partial<T>) => T
  ): void {
    const existing = this.get(key);
    if (!existing) return;

    const merged = mergeFn ? mergeFn(existing, updates) : { ...existing, ...updates };
    this.set(key, merged);
  }

  // Batch operations to reduce storage frequency
  private pendingBatch = new Map<string, T>();
  private batchTimeout: NodeJS.Timeout | null = null;

  setBatched(key: string, data: T): void {
    this.pendingBatch.set(key, data);

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    this.batchTimeout = setTimeout(() => {
      this.flushBatch();
    }, 1000); // Batch writes every 1 second
  }

  private flushBatch(): void {
    for (const [key, data] of this.pendingBatch.entries()) {
      this.set(key, data);
    }
    this.pendingBatch.clear();
    this.batchTimeout = null;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePattern(pattern: RegExp): void {
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  // Get cache statistics
  getStats() {
    const entries = Array.from(this.cache.values());
    return {
      size: this.cache.size,
      totalAccesses: entries.reduce((sum, entry) => sum + entry.accessCount, 0),
      averageAge: entries.length > 0 
        ? entries.reduce((sum, entry) => sum + (Date.now() - entry.timestamp), 0) / entries.length
        : 0,
      userActivity: this.userActivity
    };
  }
}

// Singleton instance
export const smartCache = new SmartCache();
```

### **LocalStorage Integration**
```typescript
// src/hooks/useSmartStorage.ts
import { useCallback, useEffect } from 'react';
import { LocalStorage } from '@raycast/api';
import { smartCache } from '../utils/smartCache';

export function useSmartStorage<T>(key: string, defaultValue: T) {
  const setValue = useCallback((value: T) => {
    // Use batched cache update
    smartCache.setBatched(key, value);
    
    // Schedule LocalStorage update
    setTimeout(() => {
      LocalStorage.setItem(key, JSON.stringify(value));
    }, 100);
  }, [key]);

  const getValue = useCallback(async (): Promise<T> => {
    // Check cache first
    const cached = smartCache.get(key);
    if (cached) return cached;

    // Fallback to LocalStorage
    try {
      const stored = await LocalStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored as string);
        smartCache.set(key, parsed);
        return parsed;
      }
    } catch (error) {
      console.error(`Failed to parse stored value for key ${key}:`, error);
    }

    return defaultValue;
  }, [key, defaultValue]);

  return { getValue, setValue };
}
```

---

## 4. Debounced Search

### **Current Issue**
Fuse.js instances are recreated on every data change and search operations are CPU-intensive.

### **Implementation Strategy**
Optimize Fuse.js configuration and implement search result caching.

### **Code Implementation**

```typescript
// src/hooks/useOptimizedSearch.ts
import Fuse from 'fuse.js';
import { useMemo, useState, useCallback, useRef } from 'react';
import { useDebouncedCallback } from 'use-debounce';

interface SearchResult<T> {
  items: T[];
  searchTime: number;
  fromCache: boolean;
}

interface SearchCache<T> {
  [query: string]: {
    results: T[];
    timestamp: number;
  };
}

export function useOptimizedSearch<T>(
  items: T[],
  options: Fuse.IFuseOptions<T>,
  debounceMs = 150
) {
  const [results, setResults] = useState<SearchResult<T>>({
    items: items,
    searchTime: 0,
    fromCache: false
  });
  
  const searchCacheRef = useRef<SearchCache<T>>({});
  const fuseRef = useRef<Fuse<T> | null>(null);
  const itemsHashRef = useRef<string>('');

  // Optimized Fuse.js configuration
  const optimizedOptions: Fuse.IFuseOptions<T> = useMemo(() => ({
    ...options,
    // Performance optimizations
    includeScore: true,
    includeMatches: false, // Disable if not needed
    findAllMatches: false, // Stop at first good match
    threshold: options.threshold || 0.3, // Slightly more strict for better performance
    distance: 50, // Limit search distance
    minMatchCharLength: 2, // Avoid single character searches
    useExtendedSearch: false, // Disable unless specifically needed
    // Optimize sorting
    sortFn: options.sortFn || ((a, b) => a.score! - b.score!)
  }), [options]);

  // Create Fuse instance only when items change significantly
  const fuseInstance = useMemo(() => {
    const itemsHash = JSON.stringify(items.map(item => 
      typeof item === 'object' && item !== null ? Object.keys(item).length : item
    ));
    
    if (itemsHashRef.current !== itemsHash) {
      itemsHashRef.current = itemsHash;
      searchCacheRef.current = {}; // Clear cache when data changes
    }

    if (!fuseRef.current || itemsHashRef.current !== itemsHash) {
      fuseRef.current = new Fuse(items, optimizedOptions);
    }
    
    return fuseRef.current;
  }, [items, optimizedOptions]);

  // Optimized search function
  const performSearch = useCallback((query: string): SearchResult<T> => {
    const startTime = performance.now();
    
    // Return all items for empty query
    if (!query.trim()) {
      return {
        items,
        searchTime: performance.now() - startTime,
        fromCache: false
      };
    }

    // Check cache first
    const normalizedQuery = query.toLowerCase().trim();
    const cached = searchCacheRef.current[normalizedQuery];
    const cacheAge = Date.now() - (cached?.timestamp || 0);
    
    if (cached && cacheAge < 60000) { // Cache for 1 minute
      return {
        items: cached.results,
        searchTime: performance.now() - startTime,
        fromCache: true
      };
    }

    // Perform search
    const fuseResults = fuseInstance.search(query, { limit: 50 }); // Limit results
    const searchResults = fuseResults.map(result => result.item);

    // Cache results
    searchCacheRef.current[normalizedQuery] = {
      results: searchResults,
      timestamp: Date.now()
    };

    // Cleanup old cache entries (keep last 20)
    const cacheKeys = Object.keys(searchCacheRef.current);
    if (cacheKeys.length > 20) {
      const oldestKeys = cacheKeys
        .sort((a, b) => 
          searchCacheRef.current[a].timestamp - searchCacheRef.current[b].timestamp
        )
        .slice(0, cacheKeys.length - 20);
      
      oldestKeys.forEach(key => delete searchCacheRef.current[key]);
    }

    return {
      items: searchResults,
      searchTime: performance.now() - startTime,
      fromCache: false
    };
  }, [fuseInstance, items]);

  // Debounced search
  const debouncedSearch = useDebouncedCallback((query: string) => {
    const result = performSearch(query);
    setResults(result);
  }, debounceMs);

  // Immediate search for cached results
  const search = useCallback((query: string) => {
    const normalizedQuery = query.toLowerCase().trim();
    const cached = searchCacheRef.current[normalizedQuery];
    
    if (cached) {
      // Immediate return for cached results
      setResults({
        items: cached.results,
        searchTime: 0,
        fromCache: true
      });
    } else {
      // Debounced search for new queries
      debouncedSearch(query);
    }
  }, [debouncedSearch]);

  return {
    search,
    results,
    clearCache: () => { searchCacheRef.current = {}; }
  };
}
```

### **Integration Example**
```typescript
// src/switch-windows-yabai.tsx
import { useOptimizedSearch } from './hooks/useOptimizedSearch';

export default function SwitchWindowsYabai(props: LaunchProps) {
  const { data: windows = [] } = useYabaiWindows();
  const { applications } = useAsyncApplications();

  // Optimized search for windows
  const windowsSearch = useOptimizedSearch(windows, {
    keys: [
      { name: 'title', weight: 2 },
      { name: 'app', weight: 1 }
    ],
    threshold: 0.3
  });

  // Optimized search for applications
  const applicationsSearch = useOptimizedSearch(applications, {
    keys: [{ name: 'name', weight: 1 }],
    threshold: 0.4
  });

  const handleSearchChange = useCallback((query: string) => {
    windowsSearch.search(query);
    applicationsSearch.search(query);
  }, [windowsSearch, applicationsSearch]);

  // Use optimized results
  const displayedWindows = windowsSearch.results.items;
  const displayedApps = applicationsSearch.results.items;
}
```

---

## 5. LocalStorage Batching

### **Current Issue**
Multiple useEffect hooks write to LocalStorage on every state change, causing excessive serialization overhead.

### **Implementation Strategy**
Implement batched operations with reduced storage frequency.

### **Code Implementation**

```typescript
// src/utils/batchedStorage.ts
interface PendingWrite<T> {
  value: T;
  priority: number;
  lastUpdate: number;
}

export class BatchedStorage {
  private pendingWrites = new Map<string, PendingWrite<any>>();
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY = 1000; // 1 second
  private readonly MAX_BATCH_SIZE = 50;
  private isFlushInProgress = false;

  // Priority levels
  static readonly PRIORITY_LOW = 1;
  static readonly PRIORITY_MEDIUM = 2;
  static readonly PRIORITY_HIGH = 3;
  static readonly PRIORITY_CRITICAL = 4;

  set<T>(key: string, value: T, priority = BatchedStorage.PRIORITY_MEDIUM): void {
    this.pendingWrites.set(key, {
      value,
      priority,
      lastUpdate: Date.now()
    });

    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    const hasCriticalWrites = Array.from(this.pendingWrites.values())
      .some(write => write.priority === BatchedStorage.PRIORITY_CRITICAL);

    const delay = hasCriticalWrites ? 100 : this.BATCH_DELAY;

    this.batchTimeout = setTimeout(() => {
      this.flushBatch();
    }, delay);
  }

  private async flushBatch(): Promise<void> {
    if (this.isFlushInProgress || this.pendingWrites.size === 0) {
      return;
    }

    this.isFlushInProgress = true;
    const writes = new Map(this.pendingWrites);
    this.pendingWrites.clear();

    try {
      // Sort by priority and batch size
      const sortedWrites = Array.from(writes.entries())
        .sort((a, b) => b[1].priority - a[1].priority)
        .slice(0, this.MAX_BATCH_SIZE);

      // Execute writes in parallel (LocalStorage operations are sync anyway)
      const writePromises = sortedWrites.map(async ([key, write]) => {
        try {
          const serialized = JSON.stringify(write.value);
          await LocalStorage.setItem(key, serialized);
          return { key, success: true };
        } catch (error) {
          console.error(`Failed to write ${key} to LocalStorage:`, error);
          // Re-queue failed writes with lower priority
          this.pendingWrites.set(key, {
            ...write,
            priority: Math.max(1, write.priority - 1)
          });
          return { key, success: false, error };
        }
      });

      await Promise.allSettled(writePromises);

      // Reschedule if there are still pending writes
      if (this.pendingWrites.size > 0) {
        this.scheduleBatch();
      }
    } finally {
      this.isFlushInProgress = false;
      this.batchTimeout = null;
    }
  }

  // Force immediate flush
  async flush(): Promise<void> {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    await this.flushBatch();
  }

  // Get current batch info
  getBatchInfo() {
    return {
      pendingCount: this.pendingWrites.size,
      isFlushInProgress: this.isFlushInProgress,
      nextFlushIn: this.batchTimeout ? this.BATCH_DELAY : 0
    };
  }
}

// Singleton instance
export const batchedStorage = new BatchedStorage();

// React hook for batched storage
import { useCallback, useEffect, useRef } from 'react';

export function useBatchedStorage<T>(key: string, initialValue: T) {
  const valueRef = useRef<T>(initialValue);

  const setValue = useCallback((value: T | ((prev: T) => T), priority?: number) => {
    const newValue = typeof value === 'function' 
      ? (value as (prev: T) => T)(valueRef.current)
      : value;
    
    valueRef.current = newValue;
    batchedStorage.set(key, newValue, priority);
  }, [key]);

  const getValue = useCallback(async (): Promise<T> => {
    try {
      const stored = await LocalStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored as string);
        valueRef.current = parsed;
        return parsed;
      }
    } catch (error) {
      console.error(`Failed to get ${key} from LocalStorage:`, error);
    }
    return initialValue;
  }, [key, initialValue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      batchedStorage.flush();
    };
  }, []);

  return [valueRef.current, setValue, getValue] as const;
}
```

### **Integration Example**
```typescript
// src/switch-windows-yabai.tsx
import { useBatchedStorage, BatchedStorage } from './utils/batchedStorage';

export default function SwitchWindowsYabai(props: LaunchProps) {
  // Replace individual useEffect hooks with batched storage
  const [usageTimes, setUsageTimes] = useBatchedStorage<Record<string, number>>('usageTimes', {});
  const [sortMethod, setSortMethod] = useBatchedStorage<SortMethod>('sortMethod', SortMethod.RECENCY);
  const [focusHistory, setFocusHistory] = useBatchedStorage<string[]>('focusHistory', []);

  // Update usage times with low priority (since it's frequently updated)
  const updateUsageTime = useCallback((windowId: string) => {
    setUsageTimes(prev => ({
      ...prev,
      [windowId]: Date.now()
    }), BatchedStorage.PRIORITY_LOW);
  }, [setUsageTimes]);

  // Update sort method with high priority (user preference)
  const updateSortMethod = useCallback((method: SortMethod) => {
    setSortMethod(method, BatchedStorage.PRIORITY_HIGH);
  }, [setSortMethod]);

  // Update focus history with medium priority
  const updateFocusHistory = useCallback((windowId: string) => {
    setFocusHistory(prev => {
      const updated = [windowId, ...prev.filter(id => id !== windowId)].slice(0, 20);
      return updated;
    }, BatchedStorage.PRIORITY_MEDIUM);
  }, [setFocusHistory]);
}
```

---

## 6. React Performance

### **Current Issue**
Complex sorting operations and unnecessary re-renders impact UI responsiveness.

### **Implementation Strategy**
Add memoization strategies and optimize useEffect dependencies.

### **Code Implementation**

```typescript
// src/hooks/useStableCallback.ts
import { useCallback, useRef } from 'react';

export function useStableCallback<T extends (...args: any[]) => any>(callback: T): T {
  const callbackRef = useRef<T>(callback);
  callbackRef.current = callback;

  return useCallback(((...args: any[]) => {
    return callbackRef.current(...args);
  }) as T, []);
}

// src/hooks/useOptimizedSorting.ts
import { useMemo } from 'react';

interface SortConfig<T> {
  items: T[];
  sortFn: (a: T, b: T) => number;
  dependencies: any[];
}

export function useOptimizedSorting<T>({ items, sortFn, dependencies }: SortConfig<T>) {
  return useMemo(() => {
    if (!items.length) return items;
    
    // Use a more efficient sorting algorithm for large datasets
    if (items.length > 1000) {
      // Quick sort implementation for large datasets
      const quickSort = (arr: T[], compare: (a: T, b: T) => number): T[] => {
        if (arr.length <= 1) return arr;
        
        const pivot = arr[Math.floor(arr.length / 2)];
        const left = arr.filter(item => compare(item, pivot) < 0);
        const center = arr.filter(item => compare(item, pivot) === 0);
        const right = arr.filter(item => compare(item, pivot) > 0);
        
        return [...quickSort(left, compare), ...center, ...quickSort(right, compare)];
      };
      
      return quickSort([...items], sortFn);
    }
    
    // Regular sort for smaller datasets
    return [...items].sort(sortFn);
  }, [items, sortFn, ...dependencies]);
}

// src/components/VirtualizedList.tsx
import React, { memo, useMemo, useState, useEffect } from 'react';

interface VirtualizedListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor: (item: T, index: number) => string;
}

function VirtualizedListComponent<T>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  keyExtractor
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);

  const visibleRange = useMemo(() => {
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.min(startIndex + visibleCount + 2, items.length);
    
    return { startIndex: Math.max(0, startIndex - 1), endIndex };
  }, [scrollTop, containerHeight, itemHeight, items.length]);

  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.startIndex, visibleRange.endIndex);
  }, [items, visibleRange.startIndex, visibleRange.endIndex]);

  const totalHeight = items.length * itemHeight;
  const offsetY = visibleRange.startIndex * itemHeight;

  return (
    <div
      style={{ height: containerHeight, overflow: 'auto' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map((item, index) => (
            <div
              key={keyExtractor(item, visibleRange.startIndex + index)}
              style={{ height: itemHeight }}
            >
              {renderItem(item, visibleRange.startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const VirtualizedList = memo(VirtualizedListComponent) as <T>(
  props: VirtualizedListProps<T>
) => React.ReactElement;
```

### **Optimized Component Structure**
```typescript
// src/components/OptimizedWindowList.tsx
import React, { memo, useMemo, useCallback } from 'react';
import { List } from '@raycast/api';
import { useOptimizedSorting } from '../hooks/useOptimizedSorting';
import { useStableCallback } from '../hooks/useStableCallback';

interface OptimizedWindowListProps {
  windows: YabaiWindow[];
  searchQuery: string;
  sortMethod: SortMethod;
  usageTimes: Record<string, number>;
  focusHistory: string[];
  onWindowSelect: (window: YabaiWindow) => void;
  onWindowFocus: (windowId: string) => void;
}

const WindowListItem = memo(({ 
  window, 
  onSelect, 
  onFocus 
}: { 
  window: YabaiWindow; 
  onSelect: () => void;
  onFocus: () => void;
}) => {
  const handleAction = useStableCallback(() => {
    onFocus();
    onSelect();
  });

  return (
    <List.Item
      key={window.id}
      title={window.title}
      subtitle={window.app}
      actions={
        <ActionPanel>
          <Action
            title="Focus Window"
            onAction={handleAction}
          />
        </ActionPanel>
      }
    />
  );
});

WindowListItem.displayName = 'WindowListItem';

export const OptimizedWindowList = memo<OptimizedWindowListProps>(({
  windows,
  searchQuery,
  sortMethod,
  usageTimes,
  focusHistory,
  onWindowSelect,
  onWindowFocus
}) => {
  // Memoized sort function
  const sortFn = useMemo(() => {
    switch (sortMethod) {
      case SortMethod.USAGE:
        return (a: YabaiWindow, b: YabaiWindow) => {
          const timeA = usageTimes[a.id] || 0;
          const timeB = usageTimes[b.id] || 0;
          return timeB - timeA;
        };
      case SortMethod.RECENCY:
        return (a: YabaiWindow, b: YabaiWindow) => {
          const indexA = focusHistory.indexOf(a.id);
          const indexB = focusHistory.indexOf(b.id);
          
          if (indexA === -1 && indexB === -1) return 0;
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
        };
      default:
        return (a: YabaiWindow, b: YabaiWindow) => a.title.localeCompare(b.title);
    }
  }, [sortMethod, usageTimes, focusHistory]);

  // Optimized sorting
  const sortedWindows = useOptimizedSorting({
    items: windows,
    sortFn,
    dependencies: [sortMethod, usageTimes, focusHistory]
  });

  // Stable callbacks
  const handleWindowSelect = useStableCallback(onWindowSelect);
  const handleWindowFocus = useStableCallback(onWindowFocus);

  return (
    <List searchText={searchQuery} searchBarPlaceholder="Search windows...">
      {sortedWindows.map((window) => (
        <WindowListItem
          key={window.id}
          window={window}
          onSelect={() => handleWindowSelect(window)}
          onFocus={() => handleWindowFocus(window.id)}
        />
      ))}
    </List>
  );
});

OptimizedWindowList.displayName = 'OptimizedWindowList';
```

---

## 7. Background Processing

### **Current Issue**
Heavy operations like file system scanning and data processing block the main thread.

### **Implementation Strategy**
Implement web worker pattern for CPU-intensive operations.

### **Code Implementation**

```typescript
// src/workers/applicationScanner.worker.ts
import { promises as fs } from 'fs';

export interface ScanRequest {
  directories: string[];
  requestId: string;
}

export interface ScanResult {
  applications: Array<{ name: string; path: string }>;
  requestId: string;
  processingTime: number;
}

// Worker message handler
self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  const { directories, requestId } = event.data;
  const startTime = performance.now();

  try {
    const applications: Array<{ name: string; path: string }> = [];

    // Process directories in parallel
    const scanPromises = directories.map(async (dir) => {
      try {
        const expandedDir = dir.replace('~', process.env.HOME || '');
        
        // Check if directory exists
        await fs.access(expandedDir);
        
        // Read directory contents
        const files = await fs.readdir(expandedDir, { withFileTypes: true });
        
        return files
          .filter(file => file.isDirectory() && file.name.endsWith('.app'))
          .map(file => ({
            name: file.name.replace('.app', ''),
            path: `${expandedDir}/${file.name}`
          }));
      } catch {
        return []; // Directory doesn't exist or no access
      }
    });

    const results = await Promise.allSettled(scanPromises);
    
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        applications.push(...result.value);
      }
    });

    const processingTime = performance.now() - startTime;

    // Send result back to main thread
    self.postMessage({
      applications,
      requestId,
      processingTime
    } as ScanResult);

  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      error: error instanceof Error ? error.message : 'Unknown error',
      requestId
    });
  }
};

// src/hooks/useWorkerApplications.ts
import { useState, useEffect, useRef, useCallback } from 'react';

interface WorkerPool {
  workers: Worker[];
  currentIndex: number;
}

export function useWorkerApplications() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const workerPoolRef = useRef<WorkerPool>({ workers: [], currentIndex: 0 });
  const pendingRequestsRef = useRef<Map<string, (result: any) => void>>(new Map());

  // Initialize worker pool
  useEffect(() => {
    const workerCount = Math.min(4, navigator.hardwareConcurrency || 2);
    const workers: Worker[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        new URL('../workers/applicationScanner.worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event) => {
        const { requestId, applications, error, processingTime } = event.data;
        const resolver = pendingRequestsRef.current.get(requestId);
        
        if (resolver) {
          pendingRequestsRef.current.delete(requestId);
          
          if (error) {
            resolver({ error });
          } else {
            resolver({ applications, processingTime });
          }
        }
      };

      workers.push(worker);
    }

    workerPoolRef.current = { workers, currentIndex: 0 };

    return () => {
      workers.forEach(worker => worker.terminate());
    };
  }, []);

  const scanApplications = useCallback(async (directories: string[]): Promise<Application[]> => {
    return new Promise((resolve, reject) => {
      const requestId = `scan_${Date.now()}_${Math.random()}`;
      const { workers, currentIndex } = workerPoolRef.current;
      
      if (workers.length === 0) {
        reject(new Error('No workers available'));
        return;
      }

      // Round-robin worker selection
      const worker = workers[currentIndex];
      workerPoolRef.current.currentIndex = (currentIndex + 1) % workers.length;

      // Store resolver for this request
      pendingRequestsRef.current.set(requestId, ({ applications, error, processingTime }) => {
        if (error) {
          reject(new Error(error));
        } else {
          console.log(`Application scan completed in ${processingTime}ms`);
          resolve(applications);
        }
      });

      // Send request to worker
      worker.postMessage({ directories, requestId });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (pendingRequestsRef.current.has(requestId)) {
          pendingRequestsRef.current.delete(requestId);
          reject(new Error('Worker timeout'));
        }
      }, 10000);
    });
  }, []);

  const loadApplications = useCallback(async (forceRefresh = false) => {
    if (isLoading && !forceRefresh) return;

    try {
      setIsLoading(true);
      setError(null);

      const directories = [
        '/Applications',
        '/System/Applications', 
        '~/Applications',
        '/System/Library/CoreServices/Applications'
      ];

      const apps = await scanApplications(directories);
      setApplications(apps);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load applications';
      setError(errorMessage);
      console.error('Application loading error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [scanApplications, isLoading]);

  return {
    applications,
    isLoading,
    error,
    loadApplications,
    refresh: () => loadApplications(true)
  };
}
```

### **Data Processing Worker**
```typescript
// src/workers/dataProcessor.worker.ts
export interface ProcessingTask {
  type: 'sort' | 'filter' | 'search';
  data: any[];
  config: any;
  requestId: string;
}

export interface ProcessingResult {
  result: any[];
  requestId: string;
  processingTime: number;
}

// Heavy sorting operations
function heavySort(items: any[], sortFn: (a: any, b: any) => number): any[] {
  // Implement efficient sorting for large datasets
  if (items.length <= 1000) {
    return [...items].sort(sortFn);
  }

  // Use merge sort for large datasets
  function mergeSort(arr: any[]): any[] {
    if (arr.length <= 1) return arr;

    const mid = Math.floor(arr.length / 2);
    const left = mergeSort(arr.slice(0, mid));
    const right = mergeSort(arr.slice(mid));

    return merge(left, right);
  }

  function merge(left: any[], right: any[]): any[] {
    const result = [];
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < left.length && rightIndex < right.length) {
      if (sortFn(left[leftIndex], right[rightIndex]) <= 0) {
        result.push(left[leftIndex]);
        leftIndex++;
      } else {
        result.push(right[rightIndex]);
        rightIndex++;
      }
    }

    return result.concat(left.slice(leftIndex), right.slice(rightIndex));
  }

  return mergeSort(items);
}

self.onmessage = async (event: MessageEvent<ProcessingTask>) => {
  const { type, data, config, requestId } = event.data;
  const startTime = performance.now();

  try {
    let result: any[] = [];

    switch (type) {
      case 'sort':
        result = heavySort(data, config.sortFn);
        break;
      case 'filter':
        result = data.filter(config.filterFn);
        break;
      case 'search':
        // Implement heavy search operations
        result = data; // Placeholder
        break;
      default:
        throw new Error(`Unknown processing type: ${type}`);
    }

    const processingTime = performance.now() - startTime;

    self.postMessage({
      result,
      requestId,
      processingTime
    } as ProcessingResult);

  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Processing error',
      requestId
    });
  }
};
```

---

## 8. Implementation Priority & Testing

### **Recommended Implementation Order**

1. **Phase 1 (Quick Wins - Week 1)**
   - Implement Smart Caching Strategy
   - Add LocalStorage Batching
   - Optimize Debounced Search

2. **Phase 2 (Core Performance - Week 2)**
   - Implement Yabai Query Consolidation
   - Add React Performance optimizations
   - Convert to Async Application Loading

3. **Phase 3 (Advanced Features - Week 3)**
   - Implement Background Processing with Workers
   - Add comprehensive error handling
   - Performance monitoring and analytics

### **Performance Testing Strategy**

```typescript
// src/utils/performanceMonitor.ts
export class PerformanceMonitor {
  private metrics = new Map<string, number[]>();

  measure<T>(operation: string, fn: () => T | Promise<T>): T | Promise<T> {
    const start = performance.now();
    
    const result = fn();
    
    if (result instanceof Promise) {
      return result.then(value => {
        this.recordMetric(operation, performance.now() - start);
        return value;
      });
    } else {
      this.recordMetric(operation, performance.now() - start);
      return result;
    }
  }

  private recordMetric(operation: string, duration: number) {
    if (!this.metrics.has(operation)) {
      this.metrics.set(operation, []);
    }
    
    const values = this.metrics.get(operation)!;
    values.push(duration);
    
    // Keep only last 100 measurements
    if (values.length > 100) {
      values.shift();
    }
  }

  getStats(operation: string) {
    const values = this.metrics.get(operation) || [];
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      avg: values.reduce((sum, v) => sum + v, 0) / values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }

  getAllStats() {
    const stats: Record<string, any> = {};
    for (const operation of this.metrics.keys()) {
      stats[operation] = this.getStats(operation);
    }
    return stats;
  }
}

export const performanceMonitor = new PerformanceMonitor();
```

### **Expected Performance Improvements**

| Optimization | Before | After | Improvement |
|-------------|--------|-------|-------------|
| Application Loading | 200-500ms | 50-100ms | 60-80% faster |
| Yabai Queries | 300-600ms | 100-200ms | 50-70% faster |
| Search Operations | 20-50ms | 5-15ms | 60-75% faster |
| LocalStorage Writes | 10-30ms | 2-5ms | 70-85% faster |
| Memory Usage | Growing | Stable | No memory leaks |
| UI Responsiveness | Laggy | Smooth | 2-3x more responsive |

---

## Implementation Priority Matrix

This section prioritizes optimization efforts based on impact vs. implementation effort:

| Optimization | Impact (1-10) | Effort (1-10) | Priority Score | Implementation Phase |
|-------------|--------------|--------------|---------------|----------------------|
| Smart Caching Strategy | **8** | **5** | **16.5** | 🥇 **Phase 1** |
| LocalStorage Batching | **7** | **3** | **13.5** | 🥇 **Phase 1** |
| Debounced Search | **7** | **4** | **14** | 🥇 **Phase 1** |
| Yabai Query Consolidation | **9** | **7** | **17.5** | 🥈 **Phase 2** |
| React Performance Optimizations | **6** | **6** | **12** | 🥈 **Phase 2** |
| Async Application Loading | **8** | **6** | **16** | 🥈 **Phase 2** |
| Background Worker Processing | **6** | **8** | **11** | 🥉 **Phase 3** |
| Error Handling Improvements | **5** | **4** | **9.5** | 🥉 **Phase 3** |

### Priority Calculation Formula
```
Priority Score = (Impact × 1.5) + (Effort × 0.5)
```

### Implementation Phases

**Phase 1: Quick Wins** (Weeks 1-2)
- Focus on high-impact, low-effort improvements
- Establish performance monitoring baseline
- Address the most critical user-facing performance issues

**Phase 2: Core Architecture** (Weeks 3-4)
- Implement foundational architectural changes
- Build centralized data management
- Optimize core rendering performance

**Phase 3: Advanced Optimizations** (Weeks 5-6)
- Implement background processing
- Add sophisticated error handling
- Finalize edge case optimizations

---

## Performance Metrics and Targets

Specific, measurable targets for each optimization area:

### 1. Application Loading

| Metric | Current Performance | Target | Measurement Method |
|--------|---------------------|--------|-------------------|
| Initial Load Time | 350-500ms | <100ms | `performance.measure()` |
| Blocking Time | 50-200ms | <10ms | Chrome DevTools Performance tab |
| Directory Scan Time | 200-450ms | <80ms async | Custom timing in worker |
| Memory Usage | 30-40MB | <25MB | Chrome memory profiler |

**Validation Criteria:**
- Application directories scanned asynchronously without UI blocking
- No frame drops during initial component mount
- Application data loaded from cache within 50ms when available

### 2. Yabai Query Efficiency

| Metric | Current Performance | Target | Measurement Method |
|--------|---------------------|--------|-------------------|
| Query Count | 3-5 per operation | 1 per operation | Custom counter in query manager |
| Query Response Time | 100-300ms | <100ms | `performance.measure()` |
| Cache Hit Rate | 0% | >60% | Custom tracking in cache layer |
| Process Creation | 3-5 per interaction | 1 per interaction | System process monitor |

**Validation Criteria:**
- All components use centralized query manager
- Requests for same data within TTL window return cached results
- Multiple concurrent requests result in single yabai process execution

### 3. Search and Filtering

| Metric | Current Performance | Target | Measurement Method |
|--------|---------------------|--------|-------------------|
| Keystroke to Result | 20-50ms | <10ms | Custom timing API |
| Large Dataset (500+ items) | 50-100ms | <30ms | Performance benchmarks |
| Memory Allocation | New Fuse instance | Reuse instance | Chrome memory allocation profiler |
| Cache Hit Rate | 0% | >70% | Custom tracking in search hook |

**Validation Criteria:**
- No visible lag during typing in search field
- Search results appear within 16ms of keystroke (60fps)
- Consistent performance regardless of dataset size

### 4. Storage Operations

| Metric | Current Performance | Target | Measurement Method |
|--------|---------------------|--------|-------------------|
| Write Operations | 1 per state change | <1 per second | LocalStorage access counter |
| Serialization Time | 5-20ms per operation | <5ms total | `performance.measure()` |
| Storage Size | Full dataset copies | Incremental updates | Chrome Application tab storage |
| Main Thread Blocking | 10-30ms | <5ms | Long task timing API |

**Validation Criteria:**
- Multiple state changes batch into single storage operation
- No UI freezing during save operations
- Storage quota stays within reasonable limits (≤5MB)

### 5. UI Responsiveness

| Metric | Current Performance | Target | Measurement Method |
|--------|---------------------|--------|-------------------|
| List Rendering Time | 20-80ms | <16ms | React DevTools Profiler |
| Re-render Count | Multiple cascading renders | Single render pass | React DevTools Profiler |
| Time to Interactive | 300-700ms | <200ms | Lighthouse metric |
| Animation Smoothness | Frame drops common | 60fps smooth | Frame timing API |

**Validation Criteria:**
- List virtualization for large datasets
- Proper component memoization to prevent unnecessary re-renders
- No jank during sorting or filtering operations

---

## Testing Strategy

Comprehensive testing approach to validate optimizations:

### 1. Performance Benchmark Suite

**Automated Test Cases:**

```typescript
// Create a comprehensive benchmark suite in /tests/benchmarks/

// Application loading benchmark
test('Async application loading performance', async () => {
  performance.mark('app-load-start');
  const { applications } = await useAsyncApplications().refresh();
  performance.mark('app-load-end');
  performance.measure('app-loading', 'app-load-start', 'app-load-end');
  
  const loadTime = getLastMeasurement('app-loading').duration;
  expect(loadTime).toBeLessThan(100); // Under 100ms
  expect(applications.length).toBeGreaterThan(10); // Proper data loading
});

// Yabai query deduplication benchmark
test('Yabai query consolidation', async () => {
  // Reset query counter
  yabaiQueryService.resetStats();
  
  // Perform multiple concurrent requests
  const promises = [
    useYabaiWindows().refetch(),
    useYabaiWindows().refetch(),
    useYabaiWindows().refetch(),
  ];
  
  await Promise.all(promises);
  const stats = yabaiQueryService.getStats();
  
  // Should only execute one actual query
  expect(stats.actualQueries).toBe(1);
  expect(stats.requestedQueries).toBe(3);
  expect(stats.cacheHits).toBe(2);
});

// Search performance benchmark
test('Search operation speed', async () => {
  // Prepare test data - 500 mock windows
  const testData = generateMockWindows(500);
  const { search, results } = useOptimizedSearch(testData, searchOptions);
  
  const searchTimes = [];
  const queries = ['chrome', 'terminal', 'code', 'finder'];
  
  // Execute multiple searches and measure time
  for (const query of queries) {
    performance.mark('search-start');
    search(query);
    await waitFor(() => results.items.length > 0);
    performance.mark('search-end');
    performance.measure('search-time', 'search-start', 'search-end');
    searchTimes.push(getLastMeasurement('search-time').duration);
  }
  
  // Calculate average search time
  const avgSearchTime = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
  expect(avgSearchTime).toBeLessThan(10); // Under 10ms average
});
```

### 2. User Experience Testing

**Simulated Interaction Tests:**

```typescript
// Test realistic user workflows
test('Complete user workflow responsiveness', async () => {
  const { getByPlaceholderText, getAllByRole, getByText } = render(<SwitchWindowsYabai />);
  
  // Measure initial render to interactive
  performance.mark('render-start');
  await waitFor(() => getByPlaceholderText('Search windows...'));
  performance.mark('render-interactive');
  performance.measure('time-to-interactive', 'render-start', 'render-interactive');
  
  // Measure search response time
  const searchInput = getByPlaceholderText('Search windows...');
  performance.mark('search-start');
  fireEvent.change(searchInput, { target: { value: 'chrome' } });
  await waitFor(() => getByText('Google Chrome'));  // Wait for results to appear
  performance.mark('search-complete');
  performance.measure('search-response', 'search-start', 'search-complete');
  
  // Measure window selection and focus time
  const chromeWindow = getByText('Google Chrome');
  performance.mark('focus-start');
  fireEvent.click(chromeWindow);
  await waitFor(() => expect(mockFocusWindow).toHaveBeenCalled());
  performance.mark('focus-end');
  performance.measure('focus-time', 'focus-start', 'focus-end');
  
  // Evaluate all timings against targets
  const timeToInteractive = getLastMeasurement('time-to-interactive').duration;
  const searchResponse = getLastMeasurement('search-response').duration;
  const focusTime = getLastMeasurement('focus-time').duration;
  
  expect(timeToInteractive).toBeLessThan(200); // Under 200ms
  expect(searchResponse).toBeLessThan(100);    // Under 100ms
  expect(focusTime).toBeLessThan(50);          // Under 50ms
});
```

### 3. Resource Utilization Testing

**Memory and CPU Usage Tests:**

```typescript
// Test for memory leaks and CPU usage
test('Stable memory usage over time', async () => {
  // Setup memory sampling
  const memorySnapshots = [];
  const intervalId = setInterval(() => {
    if (performance.memory) {
      memorySnapshots.push(performance.memory.usedJSHeapSize);
    }
  }, 1000);
  
  const { getByPlaceholderText } = render(<SwitchWindowsYabai />);
  const searchInput = getByPlaceholderText('Search windows...');
  
  // Simulate intensive user interaction
  for (let i = 0; i < 50; i++) {
    fireEvent.change(searchInput, { target: { value: `test query ${i}` } });
    await waitFor(() => screen.getByText(/test query/i));
    await new Promise(r => setTimeout(r, 50)); // Brief pause between operations
  }
  
  // Cleanup interval
  clearInterval(intervalId);
  
  // Calculate memory growth
  const initialMemory = memorySnapshots[0];
  const peakMemory = Math.max(...memorySnapshots);
  const finalMemory = memorySnapshots[memorySnapshots.length - 1];
  
  // Assert stable memory usage
  expect(finalMemory).toBeLessThanOrEqual(initialMemory * 1.2); // Allow 20% overhead
  expect(peakMemory).toBeLessThan(50 * 1024 * 1024); // Peak under 50MB
});
```

### 4. Regression Testing

**Performance Regression Detection:**

```typescript
// Add to CI pipeline to detect performance regressions
test('No performance regression from baseline', async () => {
  // Load performance baseline from previous good build
  const baseline = require('./baseline-metrics.json');
  
  // Run current performance benchmarks
  const currentMetrics = await runAllPerformanceBenchmarks();
  
  // Compare each metric against baseline with 10% regression allowance
  for (const [metricName, baseValue] of Object.entries(baseline)) {
    const currentValue = currentMetrics[metricName];
    const regressionPercentage = (currentValue - baseValue) / baseValue;
    
    // Log all metrics for tracking
    console.log(`${metricName}: ${baseValue}ms → ${currentValue}ms (${regressionPercentage.toFixed(2)}%)`);  
    
    // Fail test if regression exceeds threshold
    expect(regressionPercentage).toBeLessThan(0.1); // Allow 10% regression
  }
});
```

### 5. Load and Stress Testing

**Edge Case Performance:**

```typescript
// Test with extreme data volumes
test('Performance with extreme window count', async () => {
  // Generate extra large dataset
  const hugeWindowList = generateMockWindows(2000); // 2000 windows
  
  // Measure sorting performance
  performance.mark('sort-start');
  const sortedWindows = useOptimizedSorting({
    items: hugeWindowList,
    sortFn: sortByUsage,
    dependencies: [sortMethod, usageTimes]
  });
  performance.mark('sort-end');
  performance.measure('huge-sort', 'sort-start', 'sort-end');
  
  // Measure search performance
  const { search, results } = useOptimizedSearch(hugeWindowList, searchOptions);
  performance.mark('search-start');
  search('chrome');
  await waitFor(() => results.items.length > 0);
  performance.mark('search-end');
  performance.measure('huge-search', 'search-start', 'search-end');
  
  // Verify performance remains within reasonable bounds
  const sortTime = getLastMeasurement('huge-sort').duration;
  const searchTime = getLastMeasurement('huge-search').duration;
  
  expect(sortTime).toBeLessThan(1000); // Under 1 second for extreme case
  expect(searchTime).toBeLessThan(200); // Under 200ms for search
});
```

---

## Migration Path

Detailed implementation strategy to safely deploy optimizations:

### Phase 1: Foundation and Quick Wins

#### Week 1: Setup and Smart Caching

**Day 1-2: Environment Setup**
```bash
# 1. Add development dependencies
npm install --save-dev jest-performance @testing-library/react performance-hooks

# 2. Create performance testing directory
mkdir -p src/tests/performance

# 3. Set up performance monitoring
npm install --save performance-now
```

**Day 3-4: Smart Cache Implementation**
1. Create `src/utils/smartCache.ts` with adaptive TTL logic
2. Implement in-memory caching layer first (non-breaking)
3. Add usage tracking and statistics gathering
4. Write unit tests for cache behavior

**Day 5: LocalStorage Batching**
1. Create `src/utils/batchedStorage.ts` 
2. Implement priority-based batching system
3. Add fallback mechanism for compatibility
4. Test storage performance impact

#### Week 2: Search and Initial Integration

**Day 1-2: Optimize Search**
1. Create `src/hooks/useOptimizedSearch.ts`
2. Add result caching and query normalization
3. Implement search configuration optimization
4. Benchmark and tune parameters

**Day 3-5: Begin Integration**
1. Apply optimizations to non-critical paths first
2. Add feature flags for controlled rollout
3. Create monitoring dashboard for metrics
4. Set up A/B testing for performance comparison

**Validation Checkpoints:**
- ✅ Performance test suite passing
- ✅ No regression in core functionality
- ✅ LocalStorage write frequency reduced by ≥70%
- ✅ Search response time improved by ≥50%

### Phase 2: Core Architecture Changes

#### Week 3: Yabai Query Management

**Day 1-2: Query Manager Implementation**
1. Create `src/hooks/useYabaiQuery.ts` 
2. Implement centralized query state management
3. Add request deduplication logic
4. Build caching layer with smart invalidation

**Day 3-4: Component Migration**
1. Start with display action components
2. Convert to using query manager hooks
3. Maintain backwards compatibility
4. Test for race conditions

**Day 5: Monitoring and Tuning**
1. Add detailed query performance metrics
2. Optimize cache TTL based on real usage
3. Implement query batching for related requests
4. Validate cache hit rates ≥60%

#### Week 4: Async Application Loading

**Day 1-3: Async Loading Implementation**
1. Create `src/hooks/useAsyncApplications.ts`
2. Implement non-blocking filesystem operations
3. Add error recovery and retry logic
4. Develop adaptive polling strategy

**Day 4-5: Full Integration**
1. Replace synchronous loading with async version
2. Add loading states and error handling
3. Implement progressive enhancement
4. Fine-tune performance parameters

**Validation Checkpoints:**
- ✅ No blocking file operations in main thread
- ✅ 50% reduction in yabai process executions
- ✅ Application data loading time reduced to ≤100ms
- ✅ All components migrated to new query system

### Phase 3: Advanced Optimizations

#### Week 5: Worker Processing

**Day 1-3: Worker Implementation**
1. Create worker files for CPU-intensive operations
2. Implement worker pool for efficient management
3. Add message passing and state synchronization
4. Develop fallback for environments without worker support

**Day 4-5: React Optimizations**
1. Add component memoization to prevent re-renders
2. Implement stable callbacks to reduce dependency changes
3. Optimize useMemo dependencies
4. Add virtualization for large lists

#### Week 6: Final Optimizations and Stability

**Day 1-2: Error Handling and Recovery**
1. Implement comprehensive error boundary system
2. Add automatic recovery from API failures
3. Create detailed error logging
4. Develop user-friendly error messages

**Day 3-5: Performance Fine-Tuning**
1. Address any remaining performance bottlenecks
2. Optimize bundle size and code splitting
3. Add final performance monitoring hooks
4. Conduct comprehensive final testing

**Validation Checkpoints:**
- ✅ All CPU-intensive work moved to background
- ✅ UI remains responsive during heavy operations
- ✅ Error recovery works in all edge cases
- ✅ Overall performance meets or exceeds targets

### Rollout Strategy

**Stage 1: Internal Testing**
- Deploy to development environment
- Run automated performance benchmarks
- Conduct manual testing with extreme workloads
- Validate all metrics against baselines

**Stage 2: Beta Testing**
- Release to limited user group (10-20%)
- Collect real-world performance metrics
- Gather user feedback on perceived performance
- Fix any issues encountered in real usage

**Stage 3: Full Rollout**
- Gradually increase user percentage (25%, 50%, 75%, 100%)
- Monitor performance metrics at each stage
- Be prepared to roll back if any regressions detected
- Compare before/after metrics for validation

**Post-Deployment Validation:**
- Run performance benchmarks weekly for first month
- Update baselines with new performance data
- Track user-reported performance issues
- Plan next optimization cycle based on data

### Rollback Plan

In case of critical issues, implement this rollback strategy:

1. **Immediate Issues:**
   - Use feature flags to disable problematic optimizations
   - Restore previous implementation path
   - Notify users of temporary performance impact

2. **Performance Regressions:**
   - Identify specific component causing regression
   - Revert only the affected optimization
   - Keep other improvements intact
   - Address issue in next development cycle

3. **Data Consistency Issues:**
   - Add data migration utility to fix inconsistencies
   - Implement automatic detection and repair
   - Provide manual recovery path if needed

## Monitoring & Maintenance

After implementation, monitor these key metrics:

- Search response times (target: ≤10ms average)
- Memory usage patterns (target: stable ≤50MB)  
- LocalStorage quota usage (target: ≤5MB total)
- Yabai query frequency (target: ≤10 per minute)
- User interaction latency (target: ≤16ms per frame)
- Worker utilization rates (target: ≤25% CPU time)

Set up performance budgets and alerts for regressions with automated weekly reports and performance trend analysis.
