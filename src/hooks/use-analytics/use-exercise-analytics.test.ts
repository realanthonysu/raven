/**
 * useExerciseAnalytics hook tests.
 *
 * 覆盖练习分数趋势、六维能力雷达算法（写作70% + 练习30% 加权、
 * 无数据默认 50、听力/口语直接平均）与最强/最弱维度判定。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@/types";
import { useExerciseAnalytics } from "./use-exercise-analytics";
import type { ParsedListening } from "./use-listening-analytics";
import type { ParsedSpeaking } from "./use-speaking-analytics";
import type { ParsedCorrection } from "./use-writing-analytics";

function makeRecord(id: number, type: HistoryRecord["type"], createdAt: string): HistoryRecord {
  return {
    id,
    type,
    input_text: `text-${id}`,
    result: "",
    graph_data: null,
    created_at: createdAt,
  };
}

/** 构造合法的 ExerciseResult JSON（score 为答对题数） */
function exerciseJson(category: string, score: number, total: number): string {
  return JSON.stringify({
    category,
    exercises: Array.from({ length: total }, (_, i) => ({
      type: "fill",
      question: `q${i}`,
      answer: "a",
      explanation: "e",
    })),
    userAnswers: Array.from({ length: total }, () => "a"),
    score,
  });
}

/** 构造已解析的写作批改记录（供雷达图写作维度使用） */
function parsedCorrection(id: number, createdAt: string, categories: string[]): ParsedCorrection {
  return {
    record: makeRecord(id, "correct", createdAt),
    result: {
      corrected_text: "c",
      corrections: categories.map((category) => ({
        original: "o",
        corrected: "f",
        category,
        explanation: "e",
      })),
      summary: "s",
    },
  };
}

/** 构造已解析的听力记录（score 为答对句数） */
function parsedListening(
  id: number,
  createdAt: string,
  score: number,
  total: number,
): ParsedListening {
  return {
    record: makeRecord(id, "listening", createdAt),
    result: {
      difficulty: "中级",
      topic: "日常对话",
      sentences: Array.from({ length: total }, (_, i) => ({ text: `s${i}`, hint: "h" })),
      userInputs: Array.from({ length: total }, () => ""),
      score,
    },
  };
}

/** 构造已解析的口语记录 */
function parsedSpeaking(id: number, createdAt: string, averageScore: number): ParsedSpeaking {
  return {
    record: makeRecord(id, "speaking", createdAt),
    result: {
      difficulty: "中级",
      topic: "日常对话",
      sentences: [{ text: "s", translation: "t" }],
      results: [],
      averageScore,
    },
  };
}

describe("useExerciseAnalytics", () => {
  it("returns default radar (all 50, trend none) and placeholder dimensions with no data", () => {
    const { result } = renderHook(() => useExerciseAnalytics([], [], [], []));

    expect(result.current.exerciseTrendData).toEqual([]);
    expect(result.current.capabilityData).toHaveLength(6);
    for (const point of result.current.capabilityData) {
      expect(point.score).toBe(50);
      expect(point.trend).toBe("none");
    }
    expect(result.current.bestDimension).toBe("暂无足够数据");
    expect(result.current.worstDimension).toBe("暂无足够数据");
    expect(result.current.wrongQuestions).toEqual([]);
  });

  it("computes exercise score trend sorted by date ascending", () => {
    const records = [
      makeRecord(2, "exercise", "2026-07-02T10:00:00"),
      makeRecord(1, "exercise", "2026-07-01T10:00:00"),
    ];
    const results = [exerciseJson("时态错误", 8, 10), exerciseJson("拼写错误", 3, 10)];

    const { result } = renderHook(() => useExerciseAnalytics(records, [], [], [], results));

    // 升序：07-01 (30%) 在前，07-02 (80%) 在后
    expect(result.current.exerciseTrendData.map((t) => t.scorePercent)).toEqual([30, 80]);
    expect(result.current.exerciseTrendData[1].label).toBe("时态错误 (8/10)");
  });

  it("filters out invalid exercise result JSON", () => {
    const records = [
      makeRecord(1, "exercise", "2026-07-01T10:00:00"),
      makeRecord(2, "exercise", "2026-07-02T10:00:00"),
    ];
    const results = ["broken", exerciseJson("时态错误", 5, 10)];

    const { result } = renderHook(() => useExerciseAnalytics(records, [], [], [], results));

    expect(result.current.parsedExercises).toHaveLength(1);
  });

  it("derives writing dimensions from correction categories (worst gets 0, clean dims get 100)", () => {
    // 一篇文章含 2 个语法维度错误（时态错误），其余维度 0 错误
    const writing = [parsedCorrection(1, "2026-07-01T10:00:00", ["时态错误", "时态错误"])];

    const { result } = renderHook(() => useExerciseAnalytics([], writing, [], []));

    const byDim = new Map(result.current.capabilityData.map((d) => [d.dimension, d]));
    expect(byDim.get("语法")?.score).toBe(0);
    expect(byDim.get("词汇")?.score).toBe(100);
    expect(byDim.get("句式")?.score).toBe(100);
    expect(byDim.get("细节")?.score).toBe(100);
    // 无听力/口语数据 → 默认 50
    expect(byDim.get("听力")?.score).toBe(50);
    expect(byDim.get("口语")?.score).toBe(50);
    // 单篇文章不足以判断趋势
    expect(byDim.get("语法")?.trend).toBe("none");

    expect(result.current.bestDimension).toBe("词汇");
    expect(result.current.worstDimension).toBe("语法");
  });

  it("combines writing score (70%) with exercise score (30%) for the same dimension", () => {
    const writing = [parsedCorrection(1, "2026-07-01T10:00:00", ["时态错误", "时态错误"])];
    // 时态错误 → 语法维度，8/10 = 80 分
    const records = [makeRecord(2, "exercise", "2026-07-02T10:00:00")];
    const results = [exerciseJson("时态错误", 8, 10)];

    const { result } = renderHook(() => useExerciseAnalytics(records, writing, [], [], results));

    const grammar = result.current.capabilityData.find((d) => d.dimension === "语法");
    // writingScore=0, exerciseScore=80 → 0*0.7 + 80*0.3 = 24
    expect(grammar?.score).toBe(24);
  });

  it("averages listening/speaking scores and detects improving trend", () => {
    const listening = [
      parsedListening(1, "2026-07-01T10:00:00", 5, 10),
      parsedListening(2, "2026-07-02T10:00:00", 5, 10),
      parsedListening(3, "2026-07-03T10:00:00", 9, 10),
      parsedListening(4, "2026-07-04T10:00:00", 9, 10),
    ];
    const speaking = [
      parsedSpeaking(5, "2026-07-01T10:00:00", 90),
      parsedSpeaking(6, "2026-07-02T10:00:00", 60),
    ];

    const { result } = renderHook(() => useExerciseAnalytics([], [], listening, speaking));

    const byDim = new Map(result.current.capabilityData.map((d) => [d.dimension, d]));
    // (50+50+90+90)/4 = 70
    expect(byDim.get("听力")?.score).toBe(70);
    expect(byDim.get("听力")?.trend).toBe("improving");
    // (90+60)/2 = 75，前后半差 30 → declining
    expect(byDim.get("口语")?.score).toBe(75);
    expect(byDim.get("口语")?.trend).toBe("declining");
  });
});
