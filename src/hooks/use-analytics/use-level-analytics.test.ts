/**
 * useLevelAnalytics sub-hook tests.
 *
 * 覆盖：空输入、解析数组→估计的接线、当前级别（useProficiencyLevel）对建议的驱动。
 * 归一化细节（百分制换算/排序/样本丢弃）已在 use-level-estimation.test.ts 覆盖，
 * 此处只验证子 hook 的编排接线。
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";
import type { ParsedExercise } from "./use-exercise-analytics";
import { useLevelAnalytics } from "./use-level-analytics";

// 可变的当前级别持有者：测试按需改写，驱动 buildSuggestions
const { mockLevel } = vi.hoisted(() => ({ mockLevel: { current: "B1" } }));
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: mockLevel.current, setLevel: vi.fn() }),
}));

function rec(id: number, createdAt: string, level: string): HistoryRecord {
  return {
    id,
    type: "exercise",
    input_text: "t",
    result: "",
    graph_data: null,
    created_at: createdAt,
    difficulty_level: level,
  };
}

/** 构造一条已解析的练习记录（满分 5/5） */
function exerciseEntry(id: number, createdAt: string, level: string): ParsedExercise {
  return {
    record: rec(id, createdAt, level),
    result: {
      category: "时态错误",
      exercises: Array.from({ length: 5 }, (_, i) => ({
        type: "fill",
        question: `q${i}`,
        answer: "a",
        explanation: "e",
      })),
      userAnswers: Array.from({ length: 5 }, () => "a"),
      score: 5,
    },
  };
}

describe("useLevelAnalytics", () => {
  beforeEach(() => {
    mockLevel.current = "B1";
  });

  it("returns empty estimates and suggestions with no data", () => {
    const { result } = renderHook(() => useLevelAnalytics([], [], [], [], []));
    expect(result.current.levelEstimates).toEqual([]);
    expect(result.current.levelSuggestions).toEqual([]);
  });

  it("derives an exercise estimate from the pre-parsed array", () => {
    const { result } = renderHook(() =>
      useLevelAnalytics([], [exerciseEntry(1, "2026-07-01T10:00:00", "B2")], [], [], []),
    );
    expect(result.current.levelEstimates.find((e) => e.skill === "exercise")).toBeDefined();
  });

  it("drives suggestions from the current level", () => {
    // 4 次 B2 满分练习 → 练习估计 B2+（置信度 medium）
    const exercise = [1, 2, 3, 4].map((i) => exerciseEntry(i, `2026-07-0${i}T10:00:00`, "B2"));

    // 当前 B1：练习高出 3 档 → 触发 upgrade-skill
    mockLevel.current = "B1";
    const { result: low } = renderHook(() => useLevelAnalytics([], exercise, [], [], []));
    expect(low.current.levelSuggestions.some((s) => s.kind === "upgrade-skill")).toBe(true);

    // 当前 C1：练习低于当前 → 无建议
    mockLevel.current = "C1";
    const { result: high } = renderHook(() => useLevelAnalytics([], exercise, [], [], []));
    expect(high.current.levelSuggestions).toEqual([]);
  });
});
