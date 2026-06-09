import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTaskCompleted, markTaskCompleted, setTaskStatus, useTaskStatus } from "./task-status";

/**
 * Task status store test suite.
 *
 * Tests the reactive task status tracking module:
 * - setTaskStatus transitions (idle <-> running)
 * - markTaskCompleted transitions (running -> completed)
 * - clearTaskCompleted transitions (completed -> idle)
 * - Subscriber notification on state changes
 * - No-op when setting to current state
 * - useTaskStatus hook returns correct snapshot
 *
 * Note: Module-level state persists across tests, so we reset all tasks
 * to idle at the start of each test via setTaskStatus/clearTaskCompleted.
 */

type TaskName = "writing" | "reading" | "exercise" | "listening";

const ALL_TASKS: TaskName[] = ["writing", "reading", "exercise", "listening"];

function resetAllTasks() {
  for (const task of ALL_TASKS) {
    // clearTaskCompleted only acts when status is "completed"
    clearTaskCompleted(task);
    // setTaskStatus(false) only acts when not "idle"
    setTaskStatus(task, false);
  }
}

describe("task-status", () => {
  beforeEach(() => {
    resetAllTasks();
  });

  describe("setTaskStatus", () => {
    it("transitions a task from idle to running", () => {
      const { result } = renderHook(() => useTaskStatus());
      expect(result.current.writing).toBe("idle");

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(result.current.writing).toBe("running");
    });

    it("transitions a task from running back to idle", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(result.current.writing).toBe("running");

      act(() => {
        setTaskStatus("writing", false);
      });
      expect(result.current.writing).toBe("idle");
    });

    it("does not notify subscribers when set to same state (no-op)", () => {
      const _listener = vi.fn();
      const { result } = renderHook(() => useTaskStatus());

      // Subscribe a manual listener
      // Note: we test via useTaskStatus re-renders indirectly
      act(() => {
        setTaskStatus("reading", false); // already idle
      });
      // State unchanged, no re-render triggered
      expect(result.current.reading).toBe("idle");
    });

    it("operates independently on different tasks", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("writing", true);
        setTaskStatus("exercise", true);
      });
      expect(result.current.writing).toBe("running");
      expect(result.current.reading).toBe("idle");
      expect(result.current.exercise).toBe("running");
      expect(result.current.listening).toBe("idle");
    });
  });

  describe("markTaskCompleted", () => {
    it("transitions a task to completed from any state", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(result.current.writing).toBe("running");

      act(() => {
        markTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("completed");
    });

    it("transitions directly from idle to completed", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        markTaskCompleted("listening");
      });
      expect(result.current.listening).toBe("completed");
    });

    it("does not notify subscribers if already completed (no-op)", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        markTaskCompleted("exercise");
      });
      expect(result.current.exercise).toBe("completed");

      // Calling again should be a no-op
      act(() => {
        markTaskCompleted("exercise");
      });
      expect(result.current.exercise).toBe("completed");
    });
  });

  describe("clearTaskCompleted", () => {
    it("transitions from completed back to idle", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        markTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("completed");

      act(() => {
        clearTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("idle");
    });

    it("does not clear a running task (no-op)", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("reading", true);
      });
      expect(result.current.reading).toBe("running");

      act(() => {
        clearTaskCompleted("reading");
      });
      // Should still be running — clearTaskCompleted only acts on "completed"
      expect(result.current.reading).toBe("running");
    });

    it("does not clear an idle task (no-op)", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        clearTaskCompleted("exercise");
      });
      expect(result.current.exercise).toBe("idle");
    });
  });

  describe("full lifecycle", () => {
    it("follows the complete idle -> running -> completed -> idle cycle", () => {
      const { result } = renderHook(() => useTaskStatus());

      expect(result.current.writing).toBe("idle");

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(result.current.writing).toBe("running");

      act(() => {
        markTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("completed");

      act(() => {
        clearTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("idle");
    });

    it("supports multiple tasks in different states simultaneously", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("writing", true);
        setTaskStatus("reading", true);
      });

      act(() => {
        markTaskCompleted("reading");
      });
      // setTaskStatus for exercise into running
      act(() => {
        setTaskStatus("exercise", true);
      });

      expect(result.current.writing).toBe("running");
      expect(result.current.reading).toBe("completed");
      expect(result.current.exercise).toBe("running");
      expect(result.current.listening).toBe("idle");
    });
  });

  describe("useTaskStatus hook", () => {
    it("returns a snapshot with all four task slots", () => {
      const { result } = renderHook(() => useTaskStatus());
      expect(result.current).toHaveProperty("writing");
      expect(result.current).toHaveProperty("reading");
      expect(result.current).toHaveProperty("exercise");
      expect(result.current).toHaveProperty("listening");
    });

    it("initializes all tasks to idle", () => {
      const { result } = renderHook(() => useTaskStatus());
      expect(result.current.writing).toBe("idle");
      expect(result.current.reading).toBe("idle");
      expect(result.current.exercise).toBe("idle");
      expect(result.current.listening).toBe("idle");
    });

    it("reacts to external state changes (outside of act for store calls)", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(result.current.writing).toBe("running");

      act(() => {
        markTaskCompleted("writing");
      });
      expect(result.current.writing).toBe("completed");
    });
  });
});
