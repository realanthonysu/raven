/**
 * Generic async cache utility —— Promise 去重 + FIFO 驱逐 + 手动失效。
 *
 * 适用于任何需要缓存异步结果的场景：配置查询、音频 URL、API 响应等。
 * 内部用 Promise 去重保证同一 key 的并发请求只触发一次底层调用。
 */

interface CacheOptions<T> {
  /** 最大缓存条目数。0 表示不驱逐。默认值：0 */
  maxSize?: number;
  /** 自定义缓存键构建函数。默认：将第一个参数转为字符串 */
  keyFn?: (...args: unknown[]) => string;
  /** 条目被驱逐时调用（用于清理资源，如 URL.revokeObjectURL） */
  onEvict?: (value: T) => void;
}

/** 缓存条目结构：包含可选的已解析值和必定存在的 Promise */
interface CacheEntry<T> {
  value?: T; // 已解析的值（用于 onEvict 清理和快速值检查）
  promise: Promise<T>; // 进行中的 Promise（实现并发请求去重）
}

/**
 * 创建异步获取器的缓存版本。
 *
 * 特性：
 * - **Promise 去重**：同一 key 的并发请求共享同一个 Promise
 * - **FIFO 驱逐**：达到 `maxSize` 时移除最早的条目
 * - **手动失效**：清除指定 key 或全部条目
 *
 * @example
 * // TTS 配置缓存（不驱逐）
 * const ttsCache = createCachedFetcher(getTTSConfig);
 * const config = await ttsCache.cached();
 * ttsCache.invalidate(); // 设置变更后清除
 *
 * @example
 * // 音频 URL 缓存（带驱逐和资源清理）
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
    // Map 保持插入顺序，第一个 key 即为最早的条目
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) return;
    const entry = cache.get(firstKey);
    cache.delete(firstKey);
    if (!entry) return;
    if (entry.value !== undefined) {
      onEvict?.(entry.value);
    } else if (onEvict) {
      // Promise 尚未解析：待其 resolve 后再执行清理
      entry.promise.then(
        (value) => onEvict(value),
        () => {}, // 拒绝时已通过 rejection 路径删除条目
      );
    }
  }

  function cached(...args: Args): Promise<T> {
    const key = keyFn(...args);
    const existing = cache.get(key);

    if (existing) return existing.promise; // 缓存命中：直接返回进行中的 Promise

    // 添加新条目前先驱逐，保持在限制范围内
    if (maxSize > 0 && cache.size >= maxSize) {
      evictOldest();
    }

    // L3: 先声明 entry 再创建 promise，避免 .then 回调引用未声明变量
    const entry: CacheEntry<T> = { promise: undefined as unknown as Promise<T> };
    cache.set(key, entry);

    const promise = fetcher(...args).then(
      (value) => {
        // 存储解析后的值，供 onEvict 清理和快速值检查使用
        entry.value = value;
        return value;
      },
      (err) => {
        // 请求失败时移除缓存条目，使后续调用重新尝试
        cache.delete(key);
        throw err;
      },
    );

    entry.promise = promise;
    return promise;
  }

  function invalidate(key?: string): void {
    if (key === undefined) {
      // 清除全部条目，对每个已解析的条目调用 onEvict
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
          // Promise 尚未解析：延迟到 resolve 后再执行清理
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
