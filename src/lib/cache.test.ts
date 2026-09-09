import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedFetcher } from "./cache";
import { raceWithAbort } from "./request-utils";

/**
 * createCachedFetcher test suite.
 *
 * Covers: cache hit/miss, FIFO eviction, Promise deduplication,
 * manual invalidation (single key and all), onEvict callback,
 * rejected fetcher removes entry for retry, custom keyFn,
 * and TTL expiry (ttlMs).
 */

describe("createCachedFetcher", () => {
  describe("basic caching (hit/miss)", () => {
    it("calls fetcher on first request", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      const result = await cached("a");
      expect(result).toBe("result-a");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith("a");
    });

    it("returns cached value on second request (no duplicate fetcher call)", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      const r1 = await cached("a");
      const r2 = await cached("a");
      expect(r1).toBe("result-a");
      expect(r2).toBe("result-a");
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("calls fetcher separately for different keys", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      await cached("a");
      await cached("b");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenNthCalledWith(1, "a");
      expect(fetcher).toHaveBeenNthCalledWith(2, "b");
    });
  });

  describe("Promise deduplication", () => {
    it("returns the same Promise for concurrent calls with the same key", () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      const p1 = cached("a");
      const p2 = cached("a");
      expect(p1).toBe(p2);
      // fetcher called once even though we haven't awaited yet
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("shares the same resolved value across concurrent callers", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      const [r1, r2] = await Promise.all([cached("x"), cached("x")]);
      expect(r1).toBe("result-x");
      expect(r2).toBe("result-x");
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe("FIFO eviction", () => {
    it("evicts the oldest entry when maxSize is reached", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher, { maxSize: 2 });

      await cached("a");
      await cached("b");
      // cache is full (a, b)

      await cached("c");
      // 'a' should be evicted, cache now has (b, c)

      expect(fetcher).toHaveBeenCalledTimes(3);

      // Requesting 'a' again should trigger a new fetch
      await cached("a");
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it("hit does not reorder — FIFO evicts the oldest inserted entry, not the recently-hit one", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher, { maxSize: 2 });

      await cached("a"); // cache: [a]
      await cached("b"); // cache: [a, b]（满 2）
      await cached("a"); // 命中 a —— FIFO 命中不重排，顺序仍为 [a, b]；若为 LRU 会重排为 [b, a]
      await cached("c"); // 触发驱逐：FIFO 淘汰最旧的 a（命中不重排）；若为 LRU 则淘汰 b

      // 区分性断言：b 未被驱逐 → 仍命中缓存；只有 a 被驱逐 → 重新请求
      expect(await cached("b")).toBe("result-b");
      expect(await cached("a")).toBe("result-a");

      // FIFO 调用序列:a、b、c、a(重取) = 4 次，第 4 次重取被驱逐的 a；
      // 若实现为 LRU(命中重排)则被驱逐的是 b，第 4 次参数会变成 "b"
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(fetcher).toHaveBeenNthCalledWith(4, "a");
    });

    it("does not evict when maxSize is 0 (unlimited)", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher, { maxSize: 0 });

      await cached("a");
      await cached("b");
      await cached("c");

      // All should still be cached
      await cached("a");
      await cached("b");
      await cached("c");
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("does not evict when cache size is below maxSize", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher, { maxSize: 5 });

      await cached("a");
      await cached("b");

      await cached("a"); // still cached
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe("onEvict callback", () => {
    it("calls onEvict when an entry is evicted due to FIFO", async () => {
      const onEvict = vi.fn();
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher, { maxSize: 1, onEvict });

      await cached("a");
      // cache full, next insert evicts "a"
      await cached("b");

      expect(onEvict).toHaveBeenCalledWith("result-a");
    });

    it("calls onEvict for pending promises after eviction resolves", async () => {
      const onEvict = vi.fn();
      let resolveFirst!: (v: string) => void;
      const fetcher = vi.fn(async (id: string) => {
        if (id === "a") {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return `result-${id}`;
      });

      const { cached } = createCachedFetcher(fetcher, { maxSize: 1, onEvict });

      // Start "a" but don't resolve yet
      const promiseA = cached("a");
      // Insert "b" -> evicts "a" (still pending)
      await cached("b");

      // onEvict should not have been called yet (a is still pending)
      expect(onEvict).not.toHaveBeenCalled();

      // Now resolve "a"
      resolveFirst?.("result-a");
      await promiseA;

      // onEvict should now be called with the resolved value
      expect(onEvict).toHaveBeenCalledWith("result-a");
    });

    it("does not call onEvict when evicted promise rejects", async () => {
      const onEvict = vi.fn();
      const fetcher = vi.fn(async (id: string) => {
        if (id === "a") return Promise.reject(new Error("fail"));
        return `result-${id}`;
      });

      const { cached } = createCachedFetcher(fetcher, { maxSize: 1, onEvict });

      // Start "a" (will reject) - ignore the rejection
      cached("a").catch(() => {});
      // Insert "b" -> evicts "a" (pending, will reject)
      await cached("b");

      // Let microtasks flush
      await new Promise((r) => setTimeout(r, 0));

      // onEvict should not be called since "a" rejected
      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  describe("rejection removes entry for retry", () => {
    it("removes cache entry when fetcher rejects", async () => {
      let shouldFail = true;
      const fetcher = vi.fn(async (id: string) => {
        if (shouldFail) throw new Error("network error");
        return `result-${id}`;
      });

      const { cached } = createCachedFetcher(fetcher);

      await expect(cached("a")).rejects.toThrow("network error");
      expect(fetcher).toHaveBeenCalledOnce();

      // Retry should call fetcher again
      shouldFail = false;
      const result = await cached("a");
      expect(result).toBe("result-a");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidate", () => {
    it("clears a specific key", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached, invalidate } = createCachedFetcher(fetcher);

      await cached("a");
      await cached("b");

      invalidate("a");
      // "a" is gone, should re-fetch
      await cached("a");
      expect(fetcher).toHaveBeenCalledTimes(3);

      // "b" is still cached
      await cached("b");
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("clears all entries when no key specified", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached, invalidate } = createCachedFetcher(fetcher);

      await cached("a");
      await cached("b");
      await cached("c");

      invalidate();

      await cached("a");
      await cached("b");
      await cached("c");
      expect(fetcher).toHaveBeenCalledTimes(6);
    });

    it("calls onEvict for each resolved entry when clearing all", async () => {
      const onEvict = vi.fn();
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached, invalidate } = createCachedFetcher(fetcher, { onEvict });

      await cached("a");
      await cached("b");

      invalidate();

      expect(onEvict).toHaveBeenCalledTimes(2);
      expect(onEvict).toHaveBeenCalledWith("result-a");
      expect(onEvict).toHaveBeenCalledWith("result-b");
    });

    it("calls onEvict when clearing a specific resolved entry", async () => {
      const onEvict = vi.fn();
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached, invalidate } = createCachedFetcher(fetcher, { onEvict });

      await cached("a");
      invalidate("a");

      expect(onEvict).toHaveBeenCalledWith("result-a");
    });

    it("handles invalidating a non-existent key gracefully", async () => {
      const fetcher = vi.fn(async (id: string) => `result-${id}`);
      const { cached, invalidate } = createCachedFetcher(fetcher);

      await cached("a");
      invalidate("nonexistent");
      // "a" should still be cached
      await cached("a");
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe("custom keyFn", () => {
    it("uses custom key function for cache key generation", async () => {
      const fetcher = vi.fn(async (a: string, b: string) => `${a}-${b}`);
      const { cached } = createCachedFetcher(fetcher, {
        keyFn: (a: unknown, b: unknown) => `${a}|${b}`,
      });

      await cached("x", "y");
      // Same composite key - should be cache hit
      const r2 = await cached("x", "y");
      expect(r2).toBe("x-y");
      expect(fetcher).toHaveBeenCalledOnce();

      // Different composite key - should be cache miss
      await cached("x", "z");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe("default keyFn", () => {
    it("uses first argument as key by default", async () => {
      const fetcher = vi.fn(async (id: string, _extra: string) => `result-${id}`);
      const { cached } = createCachedFetcher(fetcher);

      await cached("a", "extra1");
      // Same first arg, different second arg - still cache hit
      await cached("a", "extra2");
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });
});

describe("rejection guard (P1 regression)", () => {
  it("rejection after eviction does not delete the re-inserted same-key entry", async () => {
    // 场景：条目 A 被 FIFO 驱逐后同 key 的新条目已插入，旧 A 的 rejection
    // 若按 key 删除会误删新条目、破坏并发去重（触发重复请求）
    const rejectors: Array<(e: Error) => void> = [];
    const fetcher = vi.fn((key: string) => {
      if (key === "a") {
        return new Promise<string>((_, reject) => {
          rejectors.push(reject);
        });
      }
      return Promise.resolve(`v-${key}`);
    });
    const { cached } = createCachedFetcher(fetcher, { maxSize: 1 });

    const p1 = cached("a"); // 第一个 a 条目（挂起）
    cached("b"); // maxSize=1 → 驱逐 a
    const p2 = cached("a"); // 同 key 重新插入（第二个挂起条目）
    expect(fetcher).toHaveBeenCalledTimes(3); // a、b、a（重新插入后重新请求）

    rejectors[0](new Error("boom"));
    await expect(p1).rejects.toThrow("boom");

    // 第一个 a 的 rejection 不应误删第二个 a：并发去重仍生效
    const p3 = cached("a");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(p3).toBe(p2);
  });
});

describe("FIFO eviction order (B3 regression)", () => {
  it("hit does not reorder insertion order — both entries get evicted over time", async () => {
    const fetcher = vi.fn(async (id: string) => `result-${id}`);
    const { cached } = createCachedFetcher(fetcher, { maxSize: 2 });

    await cached("a");
    await cached("b");
    // 再次访问 a → FIFO 命中不重排，插入顺序仍为 [a, b]
    await cached("a");
    await cached("c"); // 触发驱逐(满 2 条)：淘汰最旧的 a（命中不重排）

    const a = await cached("a"); // a 已被驱逐 → 重新请求（此时淘汰 b）
    const b = await cached("b"); // b 也被驱逐 → 重新请求（此时淘汰 c）
    expect(a).toBe("result-a");
    expect(b).toBe("result-b");
    // 调用序列:a、b、c、a(重取)、b(重取) = 5 次
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

// ── 问题 1 回归：缓存共享 Promise 与调用者 abort 的隔离 ──
// 此前缓存的 Promise 绑定第一个调用者的 AbortSignal：A 中止会令共享
// Promise reject 并触发条目移除，正在等待的 B 一起失败。
// 现约定：cached() 的 fetcher 不接收任何调用者 signal；等待者侧用
// raceWithAbort 按调用者独立桥接 abort。
describe("shared promise vs caller abort (abort isolation regression)", () => {
  it("one caller's abort does not reject the shared promise or other waiters", async () => {
    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(
      (_id: string) =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { cached } = createCachedFetcher(fetcher);

    const controllerA = new AbortController();
    const promiseA = raceWithAbort(cached("a"), controllerA.signal);
    const promiseB = raceWithAbort(cached("a")); // B 无 signal，等待同一共享 Promise

    expect(fetcher).toHaveBeenCalledOnce(); // 并发去重仍生效

    controllerA.abort(); // A 中止
    await expect(promiseA).rejects.toMatchObject({ name: "AbortError" });

    // A 中止后 B 依然能拿到结果（共享 Promise 未被污染）
    resolveFetch("result-a");
    await expect(promiseB).resolves.toBe("result-a");
  });

  it("aborted waiter does not evict the cache entry (retry still hits cache)", async () => {
    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(
      (_id: string) =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const onEvict = vi.fn();
    const { cached } = createCachedFetcher(fetcher, { onEvict });

    const controllerA = new AbortController();
    const promiseA = raceWithAbort(cached("a"), controllerA.signal);
    const promiseB = cached("a");
    controllerA.abort();
    await expect(promiseA).rejects.toMatchObject({ name: "AbortError" });

    resolveFetch("result-a");
    await expect(promiseB).resolves.toBe("result-a");

    // 条目未被 A 的中止清除：后续调用命中缓存，不重复请求
    await expect(raceWithAbort(cached("a"))).resolves.toBe("result-a");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("already-aborted signal rejects only that waiter without touching the fetcher", async () => {
    const fetcher = vi.fn(async (id: string) => `result-${id}`);
    const { cached } = createCachedFetcher(fetcher);

    const controller = new AbortController();
    controller.abort();

    await expect(raceWithAbort(cached("a"), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // 预中止的等待者不发起请求；其他无 signal 调用照常工作
    await expect(raceWithAbort(cached("a"))).resolves.toBe("result-a");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

// ── TTL 过期（ttlMs）──
// 条目在 Promise 首次解析时记录 fetchedAt；下次命中时若 Date.now() - fetchedAt
// 达到 ttlMs 则删除条目重新拉取。未解析的进行中请求（fetchedAt 未设置）
// 不参与过期判断，继续走并发去重。
describe("TTL expiry (ttlMs)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves from cache when TTL has not elapsed", async () => {
    const fetcher = vi.fn(async (id: string) => `result-${id}`);
    const { cached } = createCachedFetcher(fetcher, { ttlMs: 1000 });

    await cached("a");
    vi.advanceTimersByTime(999);

    expect(await cached("a")).toBe("result-a");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("re-fetches when TTL has elapsed", async () => {
    const fetcher = vi.fn(async (id: string) => `result-${id}`);
    const { cached } = createCachedFetcher(fetcher, { ttlMs: 1000 });

    await cached("a");
    vi.advanceTimersByTime(1000); // 恰好等于 ttlMs：>= 判定为过期

    expect(await cached("a")).toBe("result-a");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, "a");
  });

  it("replaces the expired entry on next access (subsequent hits use the fresh value)", async () => {
    let version = 1;
    const fetcher = vi.fn(async (id: string) => `result-${id}-v${version}`);
    const { cached } = createCachedFetcher(fetcher, { ttlMs: 1000 });

    expect(await cached("a")).toBe("result-a-v1");
    vi.advanceTimersByTime(1000);

    version = 2;
    // 过期条目在下次访问时被替换为新条目
    expect(await cached("a")).toBe("result-a-v2");
    expect(fetcher).toHaveBeenCalledTimes(2);

    // 新条目未过期：命中缓存
    expect(await cached("a")).toBe("result-a-v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not start a second concurrent fetch for an in-flight entry even past TTL", async () => {
    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(
      (_id: string) =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { cached } = createCachedFetcher(fetcher, { ttlMs: 1000 });

    const p1 = cached("a"); // 进行中条目，fetchedAt 尚未设置
    vi.advanceTimersByTime(10_000); // 远超 TTL，但条目仍未解析

    // 过期判断要求 fetchedAt 已存在：进行中请求继续去重，不并发第二个
    const p2 = cached("a");
    expect(p2).toBe(p1);
    expect(fetcher).toHaveBeenCalledOnce();

    resolveFetch("result-a");
    await expect(p1).resolves.toBe("result-a");
    await expect(p2).resolves.toBe("result-a");
  });

  it("without ttlMs, entries never expire (permanent cache until FIFO eviction)", async () => {
    const fetcher = vi.fn(async (id: string) => `result-${id}`);
    const { cached } = createCachedFetcher(fetcher, { maxSize: 2 });

    await cached("a");
    vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365); // 一年后仍命中

    expect(await cached("a")).toBe("result-a");
    expect(fetcher).toHaveBeenCalledOnce();

    // 永久缓存的驱逐仍由 FIFO maxSize 决定
    await cached("b");
    await cached("c"); // 满 2 条：淘汰 a
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cached("a");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
