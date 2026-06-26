import { describe, expect, it, vi } from "vitest";
import { createCachedFetcher } from "./cache";

/**
 * createCachedFetcher test suite.
 *
 * Covers: cache hit/miss, FIFO eviction, Promise deduplication,
 * manual invalidation (single key and all), onEvict callback,
 * rejected fetcher removes entry for retry, and custom keyFn.
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
