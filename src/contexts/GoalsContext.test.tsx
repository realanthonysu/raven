import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock 数据库层（GoalsContext 仅使用 getLearningGoals）
vi.mock("@/lib/db", () => ({
  getLearningGoals: vi.fn(),
}));

import { getLearningGoals } from "@/lib/db";
import { type GoalDto, GoalsProvider, goalsToRecord, useGoals } from "./GoalsContext";

// ─── goalsToRecord ──────────────────────────────────────────────────

describe("goalsToRecord", () => {
  it("converts GoalDto array to Record<string, number>", () => {
    const goals: GoalDto[] = [
      { goal_type: "reading", target: 30 },
      { goal_type: "writing", target: 20 },
    ];
    const result = goalsToRecord(goals);
    expect(result).toEqual({ reading: 30, writing: 20 });
  });

  it("returns empty object for empty array", () => {
    expect(goalsToRecord([])).toEqual({});
  });

  it("handles single goal", () => {
    const result = goalsToRecord([{ goal_type: "listening", target: 15 }]);
    expect(result).toEqual({ listening: 15 });
  });

  it("overwrites duplicate goal types with last value", () => {
    const goals: GoalDto[] = [
      { goal_type: "reading", target: 10 },
      { goal_type: "reading", target: 20 },
    ];
    const result = goalsToRecord(goals);
    expect(result.reading).toBe(20);
  });
});

// ─── GoalsProvider / useGoals ───────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <GoalsProvider>{children}</GoalsProvider>;
}

describe("useGoals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when used outside GoalsProvider", () => {
    expect(() => renderHook(() => useGoals())).toThrow(
      "useGoals must be used within <GoalsProvider>",
    );
  });

  it("starts with an empty goals list", () => {
    const { result } = renderHook(() => useGoals(), { wrapper });

    expect(result.current.goals).toEqual([]);
  });

  it("setGoals replaces the goals list directly", () => {
    const { result } = renderHook(() => useGoals(), { wrapper });

    act(() => {
      result.current.setGoals([{ goal_type: "reading", target: 30 }]);
    });

    expect(result.current.goals).toEqual([{ goal_type: "reading", target: 30 }]);
  });

  it("refreshGoals loads goals from db and converts Record to GoalDto[]", async () => {
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 30, listening: 15 });
    const { result } = renderHook(() => useGoals(), { wrapper });

    await act(async () => {
      await result.current.refreshGoals();
    });

    expect(result.current.goals).toEqual([
      { goal_type: "reading", target: 30 },
      { goal_type: "listening", target: 15 },
    ]);
  });

  it("refreshGoals warns and keeps previous goals when db call fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 30 });
    const { result } = renderHook(() => useGoals(), { wrapper });

    await act(async () => {
      await result.current.refreshGoals();
    });

    vi.mocked(getLearningGoals).mockRejectedValue(new Error("db down"));
    // 不应抛出异常，仅 console.warn
    await act(async () => {
      await result.current.refreshGoals();
    });

    expect(result.current.goals).toEqual([{ goal_type: "reading", target: 30 }]);
    expect(warnSpy).toHaveBeenCalledWith("[GoalsContext] refreshGoals failed:", expect.any(Error));
  });
});
