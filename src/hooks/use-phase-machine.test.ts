import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePhaseMachine } from "./use-phase-machine";

type ThreePhase = "loading" | "answering" | "review";

describe("usePhaseMachine", () => {
  it("sets the initial phase correctly", () => {
    const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

    expect(result.current.phase).toBe("loading");
    expect(result.current.isPhase("loading")).toBe(true);
    expect(result.current.isPhase("answering")).toBe(false);
  });

  describe("transition", () => {
    it("updates the phase", () => {
      const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      act(() => {
        result.current.transition("answering");
      });

      expect(result.current.phase).toBe("answering");
    });

    it("calls onExit for the current phase, then onEnter for the next", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onExit: {
            loading: () => calls.push("exit:loading"),
          },
          onEnter: {
            answering: () => calls.push("enter:answering"),
          },
        }),
      );

      act(() => {
        result.current.transition("answering");
      });

      expect(calls).toEqual(["exit:loading", "enter:answering"]);
    });

    it("works when only onExit is defined", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onExit: {
            loading: () => calls.push("exit:loading"),
          },
        }),
      );

      act(() => {
        result.current.transition("answering");
      });

      expect(calls).toEqual(["exit:loading"]);
      expect(result.current.phase).toBe("answering");
    });

    it("works when only onEnter is defined", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onEnter: {
            answering: () => calls.push("enter:answering"),
          },
        }),
      );

      act(() => {
        result.current.transition("answering");
      });

      expect(calls).toEqual(["enter:answering"]);
      expect(result.current.phase).toBe("answering");
    });

    it("works when no config is provided", () => {
      const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      act(() => {
        result.current.transition("answering");
      });

      expect(result.current.phase).toBe("answering");
    });

    it("skips callbacks that are not defined for the current/next phase", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onExit: {
            review: () => calls.push("exit:review"),
          },
          onEnter: {
            review: () => calls.push("enter:review"),
          },
        }),
      );

      // loading -> answering: no onExit.loading or onEnter.answering defined
      act(() => {
        result.current.transition("answering");
      });

      expect(calls).toEqual([]);
      expect(result.current.phase).toBe("answering");
    });

    it("chains multiple transitions correctly", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onExit: {
            loading: () => calls.push("exit:loading"),
            answering: () => calls.push("exit:answering"),
          },
          onEnter: {
            answering: () => calls.push("enter:answering"),
            review: () => calls.push("enter:review"),
          },
        }),
      );

      act(() => {
        result.current.transition("answering");
      });
      expect(calls).toEqual(["exit:loading", "enter:answering"]);

      act(() => {
        result.current.transition("review");
      });
      expect(calls).toEqual(["exit:loading", "enter:answering", "exit:answering", "enter:review"]);
    });
  });

  describe("setPhase", () => {
    it("updates phase without calling any callbacks", () => {
      const calls: string[] = [];
      const { result } = renderHook(() =>
        usePhaseMachine<ThreePhase>("loading", {
          onExit: {
            loading: () => calls.push("exit:loading"),
          },
          onEnter: {
            review: () => calls.push("enter:review"),
          },
        }),
      );

      act(() => {
        result.current.setPhase("review");
      });

      expect(result.current.phase).toBe("review");
      expect(calls).toEqual([]);
    });

    it("is useful for error recovery jumps", () => {
      const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      act(() => {
        result.current.transition("answering");
      });
      expect(result.current.phase).toBe("answering");

      // Simulate error: jump directly back to loading without cleanup
      act(() => {
        result.current.setPhase("loading");
      });
      expect(result.current.phase).toBe("loading");
    });
  });

  describe("isPhase", () => {
    it("returns true for the current phase", () => {
      const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      expect(result.current.isPhase("loading")).toBe(true);
      expect(result.current.isPhase("answering")).toBe(false);
    });

    it("updates after transition", () => {
      const { result } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      act(() => {
        result.current.transition("answering");
      });

      expect(result.current.isPhase("loading")).toBe(false);
      expect(result.current.isPhase("answering")).toBe(true);
    });
  });

  describe("callback stability", () => {
    it("transition function reference is stable across re-renders", () => {
      const { result, rerender } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      const firstTransition = result.current.transition;
      rerender();
      expect(result.current.transition).toBe(firstTransition);
    });

    it("setPhase function reference is stable across re-renders", () => {
      const { result, rerender } = renderHook(() => usePhaseMachine<ThreePhase>("loading"));

      const firstSetPhase = result.current.setPhase;
      rerender();
      expect(result.current.setPhase).toBe(firstSetPhase);
    });

    it("transition uses latest config even when config object changes", () => {
      const calls: string[] = [];

      const { result, rerender } = renderHook(
        ({ cb }: { cb: () => void }) =>
          usePhaseMachine<ThreePhase>("loading", {
            onEnter: { answering: cb },
          }),
        { initialProps: { cb: () => calls.push("v1") } },
      );

      act(() => {
        result.current.transition("answering");
      });
      expect(calls).toEqual(["v1"]);

      // Update the callback via a new config object
      rerender({ cb: () => calls.push("v2") });

      act(() => {
        result.current.setPhase("loading");
        result.current.transition("answering");
      });
      expect(calls).toEqual(["v1", "v2"]);
    });
  });
});
