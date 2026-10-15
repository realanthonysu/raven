import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStaleGuard } from "./use-stale-guard";

describe("useStaleGuard", () => {
  // ── begin ────────────────────────────────────────────────────────

  describe("begin", () => {
    it("returns monotonically increasing sequence numbers", () => {
      const { result } = renderHook(() => useStaleGuard());

      let first = 0;
      let second = 0;
      let third = 0;
      act(() => {
        first = result.current.begin();
        second = result.current.begin();
        third = result.current.begin();
      });

      expect(first).toBe(1);
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
    });

    it("expires the previous owner when a new begin lands", () => {
      const { result } = renderHook(() => useStaleGuard());

      let ownerSeq = 0;
      act(() => {
        ownerSeq = result.current.begin();
      });
      // 所有者在途：未发生新的 begin 时不是过期响应
      expect(result.current.isStale(ownerSeq)).toBe(false);

      act(() => {
        result.current.begin();
      });
      // 新一次 begin 使旧所有者过期——其结果不得写回 state
      expect(result.current.isStale(ownerSeq)).toBe(true);
    });
  });

  // ── current ──────────────────────────────────────────────────────

  describe("current", () => {
    it("reads the current sequence without incrementing", () => {
      const { result } = renderHook(() => useStaleGuard());

      let begun = 0;
      act(() => {
        begun = result.current.begin();
      });

      let observed = -1;
      act(() => {
        observed = result.current.current();
        // 只读访问：再次读取仍是同一序号，自身不推进
        expect(result.current.current()).toBe(observed);
      });

      expect(observed).toBe(begun);
      // 序号未被 current() 改动：在途所有者依然新鲜
      expect(result.current.isStale(begun)).toBe(false);
    });

    it("does not invalidate an in-flight owner (loadMore observer pattern)", () => {
      // 分页 loadMore 只观察"期间是否有新的列表加载发起"：自身不是所有者，
      // 不得作废更早发起、尚未返回的加载——否则列表停在旧页且无重试
      const { result } = renderHook(() => useStaleGuard());

      let ownerSeq = 0;
      let observedAtStart = -1;
      act(() => {
        ownerSeq = result.current.begin();
        observedAtStart = result.current.current();
      });

      expect(observedAtStart).toBe(ownerSeq);
      // 观察者只读采样后，在途所有者未被误伤
      expect(result.current.isStale(ownerSeq)).toBe(false);
      expect(result.current.isStale(observedAtStart)).toBe(false);
    });
  });

  // ── isStale ──────────────────────────────────────────────────────

  describe("isStale", () => {
    it("treats the latest begin as fresh and every earlier one as stale", () => {
      const { result } = renderHook(() => useStaleGuard());

      let first = 0;
      let second = 0;
      let third = 0;
      act(() => {
        first = result.current.begin();
        second = result.current.begin();
        third = result.current.begin();
      });

      expect(result.current.isStale(first)).toBe(true);
      expect(result.current.isStale(second)).toBe(true);
      expect(result.current.isStale(third)).toBe(false);
    });
  });

  // ── re-render ────────────────────────────────────────────────────

  describe("re-render", () => {
    it("keeps the sequence across re-renders (ref semantics)", () => {
      const { result, rerender } = renderHook(() => useStaleGuard());

      let seq = 0;
      act(() => {
        seq = result.current.begin();
      });
      rerender();

      expect(result.current.current()).toBe(seq);
      expect(result.current.isStale(seq)).toBe(false);

      // 重渲染后的新 begin 同样能使旧序号过期
      act(() => {
        result.current.begin();
      });
      expect(result.current.isStale(seq)).toBe(true);
    });
  });
});
