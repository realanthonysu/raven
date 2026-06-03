/**
 * Generic async cache utility —— Promise 去重 + FIFO 驱逐 + 手动失效。
 *
 * 适用于任何需要缓存异步结果的场景：配置查询、音频 URL、API 响应等。
 * 内部用 Promise 去重保证同一 key 的并发请求只触发一次底层调用。
 */

interface CacheOptions<T> {
  /** Maximum entries. 0 = no eviction. Default: 0 */
  maxSize?: number;
  /** Custom key builder. Default: first arg serialized as string */
  keyFn?: (...args: unknown[]) => string;
  /** Called when an entry is evicted (for cleanup, e.g., URL.revokeObjectURL) */
  onEvict?: (value: T) => void;
}

interface CacheEntry<T> {
  value?: T;
  promise: Promise<T>;
}

/**
 * Creates a cached version of an async fetcher function.
 *
 * Features:
 * - **Promise deduplication**: concurrent calls for the same key share one Promise
 * - **FIFO eviction**: when `maxSize` is reached, the oldest entry is removed
 * - **Manual invalidation**: clear a specific key or all entries
 *
 * @example
 * // TTS config cache (no eviction)
 * const ttsCache = createCachedFetcher(getTTSConfig);
 * const config = await ttsCache.cached();
 * ttsCache.invalidate(); // clear after settings change
 *
 * @example
 * // Audio URL cache with eviction and cleanup
 * const audioCache = createCachedFetcher(
 *   async (text: string) => { ... return URL.createObjectURL(blob); },
 *   { maxSize: 200, keyFn: (text, voice) => `${text}|${voice}`, onEvict: URL.revokeObjectURL }
 * );
 */
export function createCachedFetcher<Args extends unknown[], T>(
  fetcher: (...args: Args) => Promise<T>,
  options?: CacheOptions<T>,
): {
  cached: (...args: Args) => Promise<T>;
  invalidate: (key?: string) => void;
} {
  const { maxSize = 0, keyFn = (...args: unknown[]) => String(args[0]), onEvict } = options ?? {};

  const cache = new Map<string, CacheEntry<T>>();

  function evictOldest(): void {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) return;
    const entry = cache.get(firstKey);
    cache.delete(firstKey);
    if (!entry) return;
    if (entry.value !== undefined) {
      onEvict?.(entry.value);
    } else if (onEvict) {
      // Pending promise: clean up once it resolves
      entry.promise.then(
        (value) => onEvict(value),
        () => {}, // rejection already deletes the entry
      );
    }
  }

  function cached(...args: Args): Promise<T> {
    const key = keyFn(...args);
    const existing = cache.get(key);

    if (existing) return existing.promise;

    // Evict before adding to stay within limit
    if (maxSize > 0 && cache.size >= maxSize) {
      evictOldest();
    }

    const promise = fetcher(...args).then(
      (value) => {
        // Store resolved value for onEvict cleanup and fast value checks
        entry.value = value;
        return value;
      },
      (err) => {
        // Remove cache entry on rejection so subsequent calls retry
        cache.delete(key);
        throw err;
      },
    );

    const entry: CacheEntry<T> = { promise };
    cache.set(key, entry);
    return promise;
  }

  function invalidate(key?: string): void {
    if (key === undefined) {
      // Clear all entries, calling onEvict for each resolved one
      if (onEvict) {
        for (const entry of cache.values()) {
          if (entry.value !== undefined) {
            onEvict(entry.value);
          } else {
            entry.promise.then(
              (value) => onEvict(value),
              () => {},
            );
          }
        }
      }
      cache.clear();
    } else {
      const entry = cache.get(key);
      if (entry) {
        cache.delete(key);
        if (entry.value !== undefined) {
          onEvict?.(entry.value);
        } else if (onEvict) {
          // Pending promise: defer cleanup until resolution
          entry.promise.then(
            (value) => onEvict(value),
            () => {},
          );
        }
      }
    }
  }

  return { cached, invalidate };
}
