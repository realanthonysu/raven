/**
 * Generic async cache utility —— Promise 去重 + FIFO 驱逐 + 手动失效。
 *
 * 适用于任何需要缓存异步结果的场景：配置查询、音频 URL、API 响应等。
 * 内部用 Promise 去重保证同一 key 的并发请求只触发一次底层调用。
 */

interface CacheOptions<Args extends unknown[], T> {
  /** 最大缓存条目数。0 表示不驱逐。默认值：0 */
  maxSize?: number;
  /** 自定义缓存键构建函数。默认：将第一个参数转为字符串。
   *  参数类型与 fetcher 一致，避免实现侧的类型断言 */
  keyFn?: (...args: Args) => string;
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
 * - **FIFO 驱逐**：达到 `maxSize` 时移除最早插入的条目（基于 Map 插入顺序）
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
  options?: CacheOptions<Args, T>,
): {
  cached: (...args: Args) => Promise<T>;
  invalidate: (key?: string) => void;
} {
  const { maxSize = 0, keyFn = (...args: Args) => String(args[0]), onEvict } = options ?? {};

  const cache = new Map<string, CacheEntry<T>>();

  /**
   * 对单个条目执行 onEvict 清理。
   * Promise 尚未解析时延迟到 resolve 后执行（拒绝时已通过 rejection 路径删除条目，无需清理）。
   */
  function disposeEntry(entry: CacheEntry<T>): void {
    if (!onEvict) return;
    if (entry.value !== undefined) {
      onEvict(entry.value);
    } else {
      entry.promise.then(onEvict, () => {});
    }
  }

  function evictOldest(): void {
    // Map 保持插入顺序，第一个 key 即为最早的条目（FIFO：命中不重排）
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) return;
    const entry = cache.get(firstKey);
    cache.delete(firstKey);
    if (entry) disposeEntry(entry);
  }

  function cached(...args: Args): Promise<T> {
    const key = keyFn(...args);
    const existing = cache.get(key);

    if (existing) return existing.promise; // 缓存命中：直接返回进行中的 Promise

    // 添加新条目前先驱逐，保持在限制范围内
    if (maxSize > 0 && cache.size >= maxSize) {
      evictOldest();
    }

    // 先发起请求再登记条目：rejection 路径通过引用比对确认归属，
    // 条目在 fetcher 首个 await 之前就已就位，不存在竞态窗口
    const promise = fetcher(...args).then(
      (value) => {
        // 存储解析后的值，供 onEvict 清理和快速值检查使用
        entry.value = value;
        return value;
      },
      (err) => {
        // 请求失败时移除缓存条目，使后续调用重新尝试。
        // 引用守卫：本条目可能已被 FIFO 驱逐、且同 key 的新条目已插入，
        // 此时按 key 删除会误删新条目、破坏并发去重——按引用比对确认后再删
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
        throw err;
      },
    );

    const entry: CacheEntry<T> = { promise };
    cache.set(key, entry);
    return promise;
  }

  function invalidate(key?: string): void {
    if (key === undefined) {
      // 清除全部条目，对每个条目调用 onEvict
      if (onEvict) {
        for (const entry of cache.values()) {
          disposeEntry(entry);
        }
      }
      cache.clear();
    } else {
      const entry = cache.get(key);
      if (entry) {
        cache.delete(key);
        disposeEntry(entry);
      }
    }
  }

  return { cached, invalidate };
}
