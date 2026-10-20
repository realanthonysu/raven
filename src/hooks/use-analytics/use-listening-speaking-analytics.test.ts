/**
 * useListeningAnalytics / useSpeakingAnalytics hook tests，
 * 外加能力雷达听力维度（useExerciseAnalytics 消费 parsedListening）的归一化锁定。
 *
 * 两个 hook 结构对称（解析 + 趋势换算），合并在一个文件中测试。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { extractJsonSafe } from "@/lib/parse-utils";
import { ListeningResultSchema, SpeakingResultSchema } from "@/lib/schemas";
import type { HistoryRecord } from "@/types";
import { useExerciseAnalytics } from "./use-exercise-analytics";
import { type ParsedListening, useListeningAnalytics } from "./use-listening-analytics";
import { type ParsedSpeaking, useSpeakingAnalytics } from "./use-speaking-analytics";

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

/** 按记录 id 构造已解析的听力数组（模拟编排层一次性解析后注入） */
function parsedListeningRecords(records: HistoryRecord[], results: string[]): ParsedListening[] {
  return records
    .map((r, i) => ({ record: r, result: extractJsonSafe(results[i], ListeningResultSchema) }))
    .filter((x): x is ParsedListening => x.result !== null);
}

/** 按记录 id 构造已解析的口语数组（模拟编排层一次性解析后注入） */
function parsedSpeakingRecords(records: HistoryRecord[], results: string[]): ParsedSpeaking[] {
  return records
    .map((r, i) => ({ record: r, result: extractJsonSafe(results[i], SpeakingResultSchema) }))
    .filter((x): x is ParsedSpeaking => x.result !== null);
}

/** 构造合法的 ListeningResult JSON（score 为答对句数） */
function listeningJson(score: number, total: number): string {
  return JSON.stringify({
    difficulty: "中级",
    topic: "日常对话",
    sentences: Array.from({ length: total }, (_, i) => ({ text: `s${i}`, hint: "h" })),
    userInputs: Array.from({ length: total }, () => ""),
    score,
  });
}

/** 构造合法的 SpeakingResult JSON */
function speakingJson(averageScore: number): string {
  return JSON.stringify({
    difficulty: "高级",
    topic: "商务英语",
    sentences: [{ text: "s", translation: "t" }],
    results: [],
    averageScore,
  });
}

describe("useListeningAnalytics", () => {
  it("returns empty data when no records", () => {
    const { result } = renderHook(() => useListeningAnalytics([]));

    expect(result.current.parsedListening).toEqual([]);
    expect(result.current.listeningTrendData).toEqual([]);
  });

  it("converts score to percent and sorts trend by date ascending", () => {
    const records = [
      makeRecord(2, "listening", "2026-07-02T10:00:00"),
      makeRecord(1, "listening", "2026-07-01T10:00:00"),
    ];
    const results = [listeningJson(4, 5), listeningJson(2, 5)];

    const { result } = renderHook(() =>
      useListeningAnalytics(parsedListeningRecords(records, results)),
    );

    // 升序：07-01 (2/5=40%) 在前，07-02 (4/5=80%) 在后
    expect(result.current.listeningTrendData.map((t) => t.scorePercent)).toEqual([40, 80]);
    expect(result.current.listeningTrendData[1].label).toBe("中级 - 日常对话 (4/5)");
  });

  it("filters invalid JSON and yields 0 percent for empty sentences", () => {
    const records = [
      makeRecord(1, "listening", "2026-07-01T10:00:00"),
      makeRecord(2, "listening", "2026-07-02T10:00:00"),
    ];
    const results = ["not json", listeningJson(0, 0)];

    const { result } = renderHook(() =>
      useListeningAnalytics(parsedListeningRecords(records, results)),
    );

    expect(result.current.parsedListening).toHaveLength(1);
    expect(result.current.listeningTrendData[0].scorePercent).toBe(0);
  });
});

describe("useSpeakingAnalytics", () => {
  it("returns empty data when no records", () => {
    const { result } = renderHook(() => useSpeakingAnalytics([]));

    expect(result.current.parsedSpeaking).toEqual([]);
    expect(result.current.speakingTrendData).toEqual([]);
  });

  it("rounds averageScore and sorts trend by date ascending", () => {
    const records = [
      makeRecord(2, "speaking", "2026-07-02T10:00:00"),
      makeRecord(1, "speaking", "2026-07-01T10:00:00"),
    ];
    const results = [speakingJson(87.5), speakingJson(60)];

    const { result } = renderHook(() =>
      useSpeakingAnalytics(parsedSpeakingRecords(records, results)),
    );

    expect(result.current.speakingTrendData.map((t) => t.scorePercent)).toEqual([60, 88]);
    expect(result.current.speakingTrendData[1].label).toBe("高级 - 商务英语 (87.5分)");
  });

  it("filters records with invalid result JSON", () => {
    const records = [
      makeRecord(1, "speaking", "2026-07-01T10:00:00"),
      makeRecord(2, "speaking", "2026-07-02T10:00:00"),
    ];
    const results = ["broken", speakingJson(75)];

    const { result } = renderHook(() =>
      useSpeakingAnalytics(parsedSpeakingRecords(records, results)),
    );

    expect(result.current.parsedSpeaking).toHaveLength(1);
  });
});

// 能力雷达的听力维度由 useExerciseAnalytics 从 parsedListening 计算，
// 与趋势图共用 listeningScorePercent 归一化口径（答对句数 → 百分制）。
describe("capability radar listening dimension", () => {
  it("normalizes listening raw score for the radar (4/5 → 80)", () => {
    const records = [makeRecord(1, "listening", "2026-07-01T10:00:00")];
    const results = [listeningJson(4, 5)];

    const { result } = renderHook(() =>
      useExerciseAnalytics([], [], parsedListeningRecords(records, results), []),
    );

    const listening = result.current.capabilityData.find((d) => d.dimension === "听力");
    expect(listening?.score).toBe(80);
  });
});
