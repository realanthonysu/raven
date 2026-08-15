/**
 * useWritingAnalytics hook tests.
 *
 * 纯派生 hook（useMemo），直接用 renderHook 驱动，无需 mock 数据库。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@/types";
import { useWritingAnalytics } from "./use-writing-analytics";

function makeRecord(
  id: number,
  createdAt: string,
  over: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    id,
    type: "correct",
    input_text: `text-${id}`,
    result: "",
    graph_data: null,
    created_at: createdAt,
    ...over,
  };
}

/** 构造合法的 CorrectionResult JSON，corrections 按给定类别生成 */
function correctionJson(categories: string[]): string {
  return JSON.stringify({
    corrected_text: "corrected",
    corrections: categories.map((category) => ({
      original: "orig",
      corrected: "fix",
      category,
      explanation: "why",
    })),
    summary: "summary",
  });
}

/** 按记录 id 构造 result Map（模拟编排层对 getHistoryResultsByType 返回值的转换） */
function resultMap(records: HistoryRecord[], results: string[]): Map<number, string> {
  return new Map(records.map((r, i) => [r.id, results[i]]));
}

describe("useWritingAnalytics", () => {
  it("returns empty stats when no records", () => {
    const { result } = renderHook(() => useWritingAnalytics([], new Map()));

    expect(result.current.parsed).toEqual([]);
    expect(result.current.totalArticles).toBe(0);
    expect(result.current.totalErrors).toBe(0);
    expect(result.current.avgErrors).toBe("0");
    expect(result.current.uniqueCategories).toBe(0);
    expect(result.current.categoryData).toEqual([]);
    expect(result.current.trendData).toEqual([]);
    expect(result.current.improvement).toBeNull();
    expect(result.current.weakCategories).toEqual([]);
  });

  it("computes totals, category distribution and trend from injected results", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00"), makeRecord(2, "2026-07-02T10:00:00")];
    const results = [
      correctionJson(["时态错误", "时态错误", "拼写错误"]),
      correctionJson(["时态错误"]),
    ];

    const { result } = renderHook(() => useWritingAnalytics(records, resultMap(records, results)));

    expect(result.current.totalArticles).toBe(2);
    expect(result.current.totalErrors).toBe(4);
    expect(result.current.avgErrors).toBe("2.0");
    expect(result.current.uniqueCategories).toBe(2);
    // 按次数降序
    expect(result.current.categoryData).toEqual([
      { name: "时态错误", count: 3 },
      { name: "拼写错误", count: 1 },
    ]);
    // trendData 按时间升序，index 从 1 开始
    expect(result.current.trendData.map((t) => t.errors)).toEqual([3, 1]);
    expect(result.current.trendData.map((t) => t.index)).toEqual([1, 2]);
  });

  it("computes improvement as first-half vs second-half comparison", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00"), makeRecord(2, "2026-07-02T10:00:00")];
    const results = [
      correctionJson(["时态错误", "时态错误", "拼写错误"]), // 3 errors
      correctionJson(["时态错误"]), // 1 error
    ];

    const { result } = renderHook(() => useWritingAnalytics(records, resultMap(records, results)));

    expect(result.current.improvement).toEqual({
      diff: 2,
      pct: "67",
      avgFirst: "3.0",
      avgSecond: "1.0",
    });
  });

  it("returns null improvement with fewer than 2 parsed records", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00")];
    const results = [correctionJson(["时态错误"])];

    const { result } = renderHook(() => useWritingAnalytics(records, resultMap(records, results)));

    expect(result.current.improvement).toBeNull();
  });

  it("filters out records with invalid result JSON", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00"), makeRecord(2, "2026-07-02T10:00:00")];
    const results = ["not valid json", correctionJson(["拼写错误"])];

    const { result } = renderHook(() => useWritingAnalytics(records, resultMap(records, results)));

    expect(result.current.totalArticles).toBe(1);
    expect(result.current.totalErrors).toBe(1);
  });

  it("falls back to record.result when results parameter is not provided", () => {
    const records = [
      makeRecord(1, "2026-07-01T10:00:00", { result: correctionJson(["主谓一致"]) }),
    ];

    const { result } = renderHook(() => useWritingAnalytics(records));

    expect(result.current.totalArticles).toBe(1);
    expect(result.current.categoryData).toEqual([{ name: "主谓一致", count: 1 }]);
  });

  it("weakCategories only considers the 10 most recent articles", () => {
    // 12 条记录：最早 2 条为 "标点错误"，其余 10 条为 "时态错误"
    const records: HistoryRecord[] = [];
    const results: string[] = [];
    for (let i = 1; i <= 12; i++) {
      records.push(makeRecord(i, `2026-07-${String(i).padStart(2, "0")}T10:00:00`));
      results.push(correctionJson([i <= 2 ? "标点错误" : "时态错误"]));
    }

    const { result } = renderHook(() => useWritingAnalytics(records, resultMap(records, results)));

    expect(result.current.weakCategories).toEqual([{ name: "时态错误", count: 10 }]);
  });
});
