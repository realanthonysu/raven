/**
 * Generic async cache utility —— Promise 去重 + FIFO 驱逐 + 手动失效 + 字节预算。
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
  /**
   * 条目存活时长（毫秒）。命中且未过期时直接返回；过期则删除并重新拉取。
   * 未设置时条目不过期（仅 FIFO 驱逐 / 手动 invalidate）。
   */
  ttlMs?: number;
  /**
   * 缓存值的**总字节预算**（配合 {@link CacheOptions.sizeOf} 使用）。
   * 已解析条目的字节总和超过该值时，按 FIFO 顺序淘汰最旧条目，直到回到预算内。
   * 0 / 未设置表示不限制。仅限制条目数（maxSize）对"大 blob 少量条目"无效，
   * 例如 TTS 音频：200 条长文本音频可达数十 MB，需要按字节回收。
   */
  maxTotalBytes?: number;
  /** 计算单个缓存值的字节占用（`maxTotalBytes` 生效时必须提供）。 */
  sizeOf?: (value: T) => number;
}

/** 缓存条目结构：包含可选的已解析值和必定存在的 Promise */
interface CacheEntry<T> {
  value?: T; // 已解析的值（用于 onEvict 清理和快速值检查）
  promise: Promise<T>; // 进行中的 Promise（实现并发请求去重）
  /** Promise 首次成功解析的时刻；未解析前为 undefined */
  fetchedAt?: number;
  /** 已解析值的字节占用（仅启用字节预算时维护；0 = 未计入/未解析） */
  bytes: number;
}

/**
 * 创建异步获取器的缓存版本。
 *
 * 特性：
 * - **Promise 去重**：同一 key 的并发请求共享同一个 Promise
 * - **FIFO 驱逐**：达到 `maxSize` 时移除最早插入的条目（基于 Map 插入顺序）
 * - **字节预算**：设置 `maxTotalBytes` + `sizeOf` 后按已解析值的总字节数回收
 * - **TTL**：可选 `ttlMs`，过期条目在下次命中时重新拉取
 * - **手动失效**：清除指定 key 或全部条目
 *
 * @example
 * // TTS 配置缓存（不驱逐）
 * const ttsCache = createCachedFetcher(getTTSConfig);
 * const config = await ttsCache.cached();
 * ttsCache.invalidate(); // 设置变更后清除
 *
 * @example
 * // 音频 URL 缓存（条目数 + 总字节双重上限，淘汰时释放 blob URL）
 * const audioCache = createCachedFetcher(
 *   async (text: string) => ({ url: URL.createObjectURL(blob), bytes: blob.size }),
 *   {
 *     maxSize: 200,
 *     maxTotalBytes: 32 * 1024 * 1024,
 *     sizeOf: (entry) => entry.bytes,
 *     keyFn: (text, voice) => `${text}|${voice}`,
 *     onEvict: (entry) => URL.revokeObjectURL(entry.url),
 *   },
 * );
 */
export function createCachedFetcher<Args extends unknown[], T>(
  fetcher: (...args: Args) => Promise<T>,
  options?: CacheOptions<Args, T>,
): {
  cached: (...args: Args) => Promise<T>;
  invalidate: (key?: string) => void;
} {
  const {
    maxSize = 0,
    keyFn = (...args: Args) => String(args[0]),
    onEvict,
    ttlMs,
    maxTotalBytes = 0,
    sizeOf,
  } = options ?? {};

  const cache = new Map<string, CacheEntry<T>>();
  /** 已解析条目的字节总量（仅启用字节预算时维护，避免无谓的加法） */
  let totalBytes = 0;
  /** 字节预算；sizeOf 缺失时按"未启用"处理，防止计数无从计算 */
  const byteBudget = maxTotalBytes > 0 && sizeOf ? maxTotalBytes : 0;

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

  /** 归还条目的字节记账（幂等：归零后重复调用不再扣减） */
  function releaseBytes(entry: CacheEntry<T>): void {
    if (entry.bytes === 0) return;
    totalBytes -= entry.bytes;
    entry.bytes = 0;
  }

  /** 删除单个条目：出表 + 归还字节 + onEvict 清理（所有移除路径的唯一出口） */
  function removeEntry(key: string, entry: CacheEntry<T>): void {
    cache.delete(key);
    releaseBytes(entry);
    disposeEntry(entry);
  }

  /** 驱逐最旧的条目（FIFO：Map 插入顺序的第一个）。`keepKey` 用于保护指定条目 */
  function evictOldest(keepKey?: string): boolean {
    for (const [key, entry] of cache) {
      if (key === keepKey) continue;
      removeEntry(key, entry);
      return true;
    }
    return false;
  }

  /**
   * 把总字节数压回预算内：持续 FIFO 淘汰，但**永不淘汰刚解析的条目**
   * （它的值正被调用方使用——如 blob URL 正在播放，淘汰即 revoke 会让播放失败）。
   * 单个条目独自超预算时也保留它，由后续插入的条目把它挤出（届时其使用已结束）。
   */
  function evictOverByteBudget(keepKey: string): void {
    while (totalBytes > byteBudget && cache.size > 1) {
      if (!evictOldest(keepKey)) return;
    }
  }

  function cached(...args: Args): Promise<T> {
    const key = keyFn(...args);
    const existing = cache.get(key);

    if (existing) {
      // TTL 过期：仅在 Promise 已解析且超过存活窗口时失效；进行中的请求继续去重
      if (
        ttlMs !== undefined &&
        existing.fetchedAt !== undefined &&
        Date.now() - existing.fetchedAt >= ttlMs
      ) {
        removeEntry(key, existing);
      } else {
        return existing.promise;
      }
    }

    // 添加新条目前先驱逐，保持在限制范围内
    if (maxSize > 0 && cache.size >= maxSize) {
      evictOldest();
    }

    // 先发起请求再登记条目：rejection 路径通过引用比对确认归属，
    // 条目在 fetcher 首个 await 之前就已就位，不存在竞态窗口。
    // 注：resolve/reject 回调引用下方才声明的 entry —— 它们最早在微任务中执行，
    // 届时 entry 已完成初始化（与原有实现同一模式）。
    const promise = fetcher(...args).then(
      (value) => {
        // 存储解析后的值，供 onEvict 清理和快速值检查使用
        entry.value = value;
        entry.fetchedAt = Date.now();
        // 条目可能在解析前已被 FIFO/字节预算淘汰：仅当仍在缓存中才计入字节总额，
        // 否则会留下永远无法归零的记账（totalBytes 只增不减 → 过度驱逐）
        if (byteBudget > 0 && cache.get(key) === entry) {
          entry.bytes = sizeOf?.(value) ?? 0;
          totalBytes += entry.bytes;
          evictOverByteBudget(key);
        }
        return value;
      },
      (err) => {
        // 请求失败时移除缓存条目，使后续调用重新尝试。
        // 引用守卫：本条目可能已被 FIFO 驱逐、且同 key 的新条目已插入，
        // 此时按 key 删除会误删新条目、破坏并发去重——按引用比对确认后再删
        if (cache.get(key) === entry) {
          removeEntry(key, entry);
        }
        throw err;
      },
    );

    const entry: CacheEntry<T> = { promise, bytes: 0 };
    cache.set(key, entry);
    return promise;
  }

  function invalidate(key?: string): void {
    if (key === undefined) {
      // 清除全部条目：逐个归还字节记账并调用 onEvict
      for (const entry of cache.values()) {
        releaseBytes(entry);
        disposeEntry(entry);
      }
      cache.clear();
    } else {
      const entry = cache.get(key);
      if (entry) {
        removeEntry(key, entry);
      }
    }
  }

  return { cached, invalidate };
}
