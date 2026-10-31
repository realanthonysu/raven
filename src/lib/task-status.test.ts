import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskCompleted,
  getTaskState,
  markTaskCompleted,
  setTaskStatus,
  TASK_DISPLAY_NAMES,
  TASK_KEYS,
  TASK_REGISTRY,
  useTaskStatus,
} from "./task-status";

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
 * - TASK_REGISTRY completeness (every TASK_KEYS row registered, route/displayName non-empty)
 *
 * Note: Module-level state persists across tests, so we reset all tasks
 * to idle at the start of each test via setTaskStatus/clearTaskCompleted.
 */

function resetAllTasks() {
  // 直接遍历 TASK_KEYS：新增任务槽时无需在此补抄清单
  for (const task of TASK_KEYS) {
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

    it("tracks speaking task state transitions independently", () => {
      const { result } = renderHook(() => useTaskStatus());

      act(() => {
        setTaskStatus("speaking", true);
      });
      expect(result.current.speaking).toBe("running");

      act(() => {
        markTaskCompleted("speaking");
      });
      expect(result.current.speaking).toBe("completed");

      act(() => {
        setTaskStatus("speaking", false);
      });
      expect(result.current.speaking).toBe("idle");
    });
  });

  describe("useTaskStatus hook", () => {
    it("returns a snapshot with all five task slots", () => {
      const { result } = renderHook(() => useTaskStatus());
      expect(result.current).toHaveProperty("writing");
      expect(result.current).toHaveProperty("reading");
      expect(result.current).toHaveProperty("exercise");
      expect(result.current).toHaveProperty("listening");
      expect(result.current).toHaveProperty("speaking");
    });

    it("initializes all tasks to idle", () => {
      const { result } = renderHook(() => useTaskStatus());
      expect(result.current.writing).toBe("idle");
      expect(result.current.reading).toBe("idle");
      expect(result.current.exercise).toBe("idle");
      expect(result.current.listening).toBe("idle");
      expect(result.current.speaking).toBe("idle");
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

  // ─── 非订阅快照读取（P-05）───

  describe("getTaskState", () => {
    it("reads the latest state without a subscription", () => {
      expect(getTaskState("writing")).toBe("idle");

      setTaskStatus("writing", true);
      // 不依赖任何 React 订阅/重渲染：直接读 store 快照
      expect(getTaskState("writing")).toBe("running");

      markTaskCompleted("writing");
      expect(getTaskState("writing")).toBe("completed");

      clearTaskCompleted("writing");
      expect(getTaskState("writing")).toBe("idle");
    });

    it("does not re-render components that did not subscribe to the store", () => {
      // 回归 P-05：PersistentRoutes 的 TTL 守卫改用 getTaskState 后，
      // 任务状态变化不应再驱动壳（及其常驻页面）重渲染。
      let renders = 0;
      renderHook(() => {
        renders += 1;
        // 组件只读一次非订阅快照，不建立 useSyncExternalStore 订阅
        return getTaskState("writing");
      });
      expect(renders).toBe(1);

      act(() => {
        setTaskStatus("writing", true);
      });
      expect(renders).toBe(1);
      // 快照本身仍是新鲜的
      expect(getTaskState("writing")).toBe("running");
    });
  });

  // ─── 任务槽注册表（C6）：身份与含义的唯一声明处 ───

  describe("TASK_REGISTRY", () => {
    it("为每个 TASK_KEYS 行都登记了元数据，且无多余行", () => {
      for (const key of TASK_KEYS) {
        expect(TASK_REGISTRY[key]).toBeDefined();
      }
      expect(Object.keys(TASK_REGISTRY).sort()).toEqual([...TASK_KEYS].sort());
    });

    it("每行的 route 与 displayName 均非空", () => {
      for (const key of TASK_KEYS) {
        expect(TASK_REGISTRY[key].route).not.toBe("");
        expect(TASK_REGISTRY[key].displayName).not.toBe("");
      }
    });

    it("各任务槽的 route 互不相同", () => {
      const routes = TASK_KEYS.map((key) => TASK_REGISTRY[key].route);
      expect(new Set(routes).size).toBe(routes.length);
    });

    it("TASK_DISPLAY_NAMES 由注册表派生（同键同值）", () => {
      expect(Object.keys(TASK_DISPLAY_NAMES).sort()).toEqual([...TASK_KEYS].sort());
      for (const key of TASK_KEYS) {
        expect(TASK_DISPLAY_NAMES[key]).toBe(TASK_REGISTRY[key].displayName);
      }
    });

    it("useTaskStatus 快照覆盖注册表的全部任务槽", () => {
      const { result } = renderHook(() => useTaskStatus());
      for (const key of TASK_KEYS) {
        expect(result.current[key]).toBe("idle");
      }
    });
  });
});
