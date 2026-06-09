import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAbortable } from "./use-abortable";

/**
 * Creates a Promise that rejects with an AbortError when the given signal fires.
 * The rejection flows directly into wrapFetch's .catch() chain -- no unhandled
 * intermediate promises.
 */
function abortablePromise<T = never>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
      { once: true },
    );
  });
}

describe("useAbortable", () => {
  // ── getSignal ──────────────────────────────────────────────────────

  describe("getSignal", () => {
    it("returns a valid AbortSignal", () => {
      const { result } = renderHook(() => useAbortable());
      const signal = result.current.getSignal();

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it("returns the same signal on repeated calls without abort", () => {
      const { result } = renderHook(() => useAbortable());

      const s1 = result.current.getSignal();
      const s2 = result.current.getSignal();
      expect(s1).toBe(s2);
    });
  });

  // ── abort ──────────────────────────────────────────────────────────

  describe("abort", () => {
    it("aborts the current signal", () => {
      const { result } = renderHook(() => useAbortable());
      const signal = result.current.getSignal();

      act(() => {
        result.current.abort();
      });

      expect(signal.aborted).toBe(true);
    });

    it("is a no-op when no controller exists", () => {
      const { result } = renderHook(() => useAbortable());

      // Should not throw.
      act(() => {
        result.current.abort();
      });
    });
  });

  // ── wrapFetch ──────────────────────────────────────────────────────

  describe("wrapFetch", () => {
    it("aborts the previous signal when a new operation starts", async () => {
      const { result } = renderHook(() => useAbortable());

      let firstSignal: AbortSignal | undefined;

      // First call -- returns a promise that rejects when the signal fires.
      const firstPromise = result.current.wrapFetch((signal) => {
        firstSignal = signal;
        return abortablePromise(signal);
      });

      // Second call -- aborts the first controller.
      const secondPromise = result.current.wrapFetch((signal) => abortablePromise(signal));

      expect(firstSignal).toBeDefined();
      expect(firstSignal?.aborted).toBe(true);

      // Abort the second operation so both promises settle.
      act(() => {
        result.current.abort();
      });

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
    });

    it("returns the resolved value of fn", async () => {
      const { result } = renderHook(() => useAbortable());

      let value: string | undefined;
      await act(async () => {
        value = await result.current.wrapFetch(async () => "hello");
      });

      expect(value).toBe("hello");
    });

    it("passes an active (non-aborted) signal to fn", async () => {
      const { result } = renderHook(() => useAbortable());

      let receivedSignal: AbortSignal | undefined;
      await act(async () => {
        await result.current.wrapFetch(async (signal) => {
          receivedSignal = signal;
        });
      });

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });

    it("returns undefined when the operation is aborted", async () => {
      const { result } = renderHook(() => useAbortable());

      // Start an operation that rejects when the signal fires.
      const promise = result.current.wrapFetch((signal) => abortablePromise(signal));

      // Abort from outside the callback.
      act(() => {
        result.current.abort();
      });

      const value = await promise;
      expect(value).toBeUndefined();
    });

    it("re-throws non-abort errors", async () => {
      const { result } = renderHook(() => useAbortable());

      const promise = result.current.wrapFetch(async () => {
        throw new Error("network down");
      });

      await expect(promise).rejects.toThrow("network down");
    });
  });

  // ── unmount ────────────────────────────────────────────────────────

  describe("unmount", () => {
    it("aborts the current signal on unmount", () => {
      const { result, unmount } = renderHook(() => useAbortable());
      const signal = result.current.getSignal();

      expect(signal.aborted).toBe(false);

      unmount();

      expect(signal.aborted).toBe(true);
    });

    it("aborts a pending wrapFetch operation on unmount", async () => {
      const { result, unmount } = renderHook(() => useAbortable());

      let capturedSignal: AbortSignal | undefined;

      // Start an operation that rejects when the signal fires.
      const fetchPromise = result.current.wrapFetch((signal) => {
        capturedSignal = signal;
        return abortablePromise(signal);
      });

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      // Unmount -- effect cleanup aborts the controller, signal fires,
      // abortablePromise rejects, .catch in wrapFetch handles it.
      unmount();

      expect(capturedSignal?.aborted).toBe(true);

      const value = await fetchPromise;
      expect(value).toBeUndefined();
    });
  });

  // ── reset ──────────────────────────────────────────────────────────

  describe("reset", () => {
    it("aborts the current controller and creates a new one", () => {
      const { result } = renderHook(() => useAbortable());
      const signalBefore = result.current.getSignal();

      act(() => {
        result.current.reset();
      });

      const signalAfter = result.current.getSignal();

      expect(signalBefore.aborted).toBe(true);
      expect(signalAfter.aborted).toBe(false);
      expect(signalAfter).not.toBe(signalBefore);
    });
  });

  // ── sequential operations ──────────────────────────────────────────

  describe("sequential operations", () => {
    it("each wrapFetch call gets its own controller -- no leaks", async () => {
      const { result } = renderHook(() => useAbortable());

      const signals: AbortSignal[] = [];

      // Three sequential calls; each aborts the previous controller.
      const p1 = result.current.wrapFetch((signal) => {
        signals.push(signal);
        return abortablePromise(signal);
      });

      const p2 = result.current.wrapFetch((signal) => {
        signals.push(signal);
        return abortablePromise(signal);
      });

      const p3 = result.current.wrapFetch(async (signal) => {
        signals.push(signal);
        return 42;
      });

      expect(signals).toHaveLength(3);
      expect(signals[0]).not.toBe(signals[1]);
      expect(signals[1]).not.toBe(signals[2]);

      // First two were aborted by subsequent calls.
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(true);
      // Last one is still active (resolved synchronously).
      expect(signals[2].aborted).toBe(false);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      expect(r3).toBe(42);
    });
  });
});
