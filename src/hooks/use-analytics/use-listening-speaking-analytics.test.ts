/**
 * useListeningAnalytics / useSpeakingAnalytics hook tests.
 *
 * 两个 hook 结构对称（解析 + 趋势换算），合并在一个文件中测试。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@/types";
import { useListeningAnalytics } from "./use-listening-analytics";
import { useSpeakingAnalytics } from "./use-speaking-analytics";

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
    const { result } = renderHook(() => useListeningAnalytics([], []));

    expect(result.current.parsedListening).toEqual([]);
    expect(result.current.listeningTrendData).toEqual([]);
  });

  it("converts score to percent and sorts trend by date ascending", () => {
    const records = [
      makeRecord(2, "listening", "2026-07-02T10:00:00"),
      makeRecord(1, "listening", "2026-07-01T10:00:00"),
    ];
    const results = [listeningJson(4, 5), listeningJson(2, 5)];

    const { result } = renderHook(() => useListeningAnalytics(records, results));

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

    const { result } = renderHook(() => useListeningAnalytics(records, results));

    expect(result.current.parsedListening).toHaveLength(1);
    expect(result.current.listeningTrendData[0].scorePercent).toBe(0);
  });
});

describe("useSpeakingAnalytics", () => {
  it("returns empty data when no records", () => {
    const { result } = renderHook(() => useSpeakingAnalytics([], []));

    expect(result.current.parsedSpeaking).toEqual([]);
    expect(result.current.speakingTrendData).toEqual([]);
  });

  it("rounds averageScore and sorts trend by date ascending", () => {
    const records = [
      makeRecord(2, "speaking", "2026-07-02T10:00:00"),
      makeRecord(1, "speaking", "2026-07-01T10:00:00"),
    ];
    const results = [speakingJson(87.5), speakingJson(60)];

    const { result } = renderHook(() => useSpeakingAnalytics(records, results));

    expect(result.current.speakingTrendData.map((t) => t.scorePercent)).toEqual([60, 88]);
    expect(result.current.speakingTrendData[1].label).toBe("高级 - 商务英语 (87.5分)");
  });

  it("filters records with invalid result JSON", () => {
    const records = [
      makeRecord(1, "speaking", "2026-07-01T10:00:00"),
      makeRecord(2, "speaking", "2026-07-02T10:00:00"),
    ];
    const results = ["broken", speakingJson(75)];

    const { result } = renderHook(() => useSpeakingAnalytics(records, results));

    expect(result.current.parsedSpeaking).toHaveLength(1);
  });
});
