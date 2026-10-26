/**
 * useWritingAnalytics hook tests.
 *
 * 纯派生 hook（useMemo），直接用 renderHook 驱动，无需 mock 数据库。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ParsedCorrection } from "@/lib/level-estimation-samples";
import { parseCorrectionJson } from "@/lib/parse-utils";
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

/** 按记录 id 构造已解析的写作批改数组（模拟编排层一次性解析后注入） */
function parsedCorrections(records: HistoryRecord[], results: string[]): ParsedCorrection[] {
  return records
    .map((r, i) => ({ record: r, result: parseCorrectionJson(results[i]) }))
    .filter((x): x is ParsedCorrection => x.result !== null);
}

describe("useWritingAnalytics", () => {
  it("returns empty stats when no records", () => {
    const { result } = renderHook(() => useWritingAnalytics([]));

    expect(result.current.parsed).toEqual([]);
    expect(result.current.totalArticles).toBe(0);
    expect(result.current.totalErrors).toBe(0);
    expect(result.current.avgErrors).toBe("0");
    expect(result.current.uniqueCategories).toBe(0);
    expect(result.current.categoryData).toEqual([]);
    expect(result.current.trendData).toEqual([]);
    expect(result.current.improvement).toBeNull();
  });

  it("computes totals, category distribution and trend from injected results", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00"), makeRecord(2, "2026-07-02T10:00:00")];
    const results = [
      correctionJson(["时态错误", "时态错误", "拼写错误"]),
      correctionJson(["时态错误"]),
    ];

    const { result } = renderHook(() => useWritingAnalytics(parsedCorrections(records, results)));

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

    const { result } = renderHook(() => useWritingAnalytics(parsedCorrections(records, results)));

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

    const { result } = renderHook(() => useWritingAnalytics(parsedCorrections(records, results)));

    expect(result.current.improvement).toBeNull();
  });

  it("filters out records with invalid result JSON", () => {
    const records = [makeRecord(1, "2026-07-01T10:00:00"), makeRecord(2, "2026-07-02T10:00:00")];
    const results = ["not valid json", correctionJson(["拼写错误"])];

    const { result } = renderHook(() => useWritingAnalytics(parsedCorrections(records, results)));

    expect(result.current.totalArticles).toBe(1);
    expect(result.current.totalErrors).toBe(1);
  });

  it("consumes pre-parsed results sourced from record.result", () => {
    const records = [
      makeRecord(1, "2026-07-01T10:00:00", { result: correctionJson(["主谓一致"]) }),
    ];

    // 编排层在未命中 resultById 时回退到 record.result 完成解析后再注入本 hook
    const parsed = parsedCorrections(
      records,
      records.map((r) => r.result),
    );
    const { result } = renderHook(() => useWritingAnalytics(parsed));

    expect(result.current.totalArticles).toBe(1);
    expect(result.current.categoryData).toEqual([{ name: "主谓一致", count: 1 }]);
  });

  // 弱项候选（computeWeakCategoryCounts 窗口 10 / 掌握度降权 / topN 截取）已
  // 收敛到 lib/exercise-stats 的 rankWeakCategories，其窗口与排序语义在
  // exercise-stats.test.ts 覆盖；编排层 top2 截取在 use-analytics/index.test.ts
  // 的 "limits weakCategories to top 2" 用例覆盖。
});
