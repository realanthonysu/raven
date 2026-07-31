/**
 * useAnalytics orchestrator hook tests.
 *
 * Mock 数据库层（getHistoryList / getHistoryResultsByType），
 * 覆盖数据获取、类型过滤、时间范围筛选、降级路径与 weakCategories 截取。
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";
import { useAnalytics } from "./index";

const mockGetHistoryList = vi.fn();
const mockGetHistoryResultsByType = vi.fn();

vi.mock("@/lib/db", () => ({
  getHistoryList: (...args: unknown[]) => mockGetHistoryList(...args),
  getHistoryResultsByType: (...args: unknown[]) => mockGetHistoryResultsByType(...args),
}));

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

/** 构造合法的 CorrectionResult JSON */
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

describe("useAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHistoryList.mockResolvedValue([]);
    mockGetHistoryResultsByType.mockResolvedValue([]);
  });

  it("fetches light records and per-type results, then clears loading", async () => {
    const { result } = renderHook(() => useAnalytics());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetHistoryList).toHaveBeenCalledWith(undefined, 500);
    // 四类需要解析 result 的记录按需获取
    for (const type of ["correct", "exercise", "listening", "speaking"]) {
      expect(mockGetHistoryResultsByType).toHaveBeenCalledWith(type, 500);
    }
  });

  it("filters records by type, treating legacy 'writing' as correct", async () => {
    mockGetHistoryList.mockResolvedValue([
      makeRecord(1, "correct", "2026-07-01T10:00:00"),
      makeRecord(2, "writing", "2026-07-02T10:00:00"),
      makeRecord(3, "exercise", "2026-07-03T10:00:00"),
      makeRecord(4, "listening", "2026-07-04T10:00:00"),
      makeRecord(5, "reading", "2026-07-05T10:00:00"),
      makeRecord(6, "speaking", "2026-07-06T10:00:00"),
    ]);

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(6);
    expect(result.current.correctRecords.map((r) => r.id)).toEqual([1, 2]);
    expect(result.current.exerciseRecords.map((r) => r.id)).toEqual([3]);
    expect(result.current.listeningRecords.map((r) => r.id)).toEqual([4]);
    expect(result.current.readingRecords.map((r) => r.id)).toEqual([5]);
    expect(result.current.speakingRecords.map((r) => r.id)).toEqual([6]);
  });

  it("aggregates writing analytics from injected result strings", async () => {
    mockGetHistoryList.mockResolvedValue([
      makeRecord(1, "correct", "2026-07-01T10:00:00"),
      makeRecord(2, "correct", "2026-07-02T10:00:00"),
    ]);
    mockGetHistoryResultsByType.mockImplementation((type: string) =>
      type === "correct"
        ? Promise.resolve([correctionJson(["时态错误", "拼写错误"]), correctionJson(["时态错误"])])
        : Promise.resolve([]),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.totalArticles).toBe(2);
    expect(result.current.totalErrors).toBe(3);
    expect(result.current.avgErrors).toBe("1.5");
    expect(result.current.categoryData[0]).toEqual({ name: "时态错误", count: 2 });
  });

  it("filters records by days when time range is set", async () => {
    const recent = new Date(Date.now() - 1 * 86400_000).toISOString();
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    mockGetHistoryList.mockResolvedValue([
      makeRecord(1, "reading", recent),
      makeRecord(2, "reading", old),
    ]);

    const { result, rerender } = renderHook(({ days }) => useAnalytics(days), {
      initialProps: { days: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(2);

    rerender({ days: 7 });
    expect(result.current.allRecords.map((r) => r.id)).toEqual([1]);
  });

  it("degrades gracefully when result fetching fails", async () => {
    mockGetHistoryList.mockResolvedValue([makeRecord(1, "correct", "2026-07-01T10:00:00")]);
    mockGetHistoryResultsByType.mockRejectedValue(new Error("ipc failed"));

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 记录列表仍可用，仅统计数据为空
    expect(result.current.allRecords).toHaveLength(1);
    expect(result.current.totalArticles).toBe(0);
  });

  it("clears loading and keeps empty records when getHistoryList fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryList.mockRejectedValue(new Error("db failed"));

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toEqual([]);
    warnSpy.mockRestore();
  });

  it("limits weakCategories to top 2 after mastery weighting", async () => {
    mockGetHistoryList.mockResolvedValue([makeRecord(1, "correct", "2026-07-01T10:00:00")]);
    mockGetHistoryResultsByType.mockImplementation((type: string) =>
      type === "correct"
        ? Promise.resolve([
            correctionJson(["时态错误", "时态错误", "拼写错误", "拼写错误", "冠词错误"]),
          ])
        : Promise.resolve([]),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.weakCategories).toHaveLength(2);
    expect(result.current.weakCategories.map((c) => c.name)).toEqual(["时态错误", "拼写错误"]);
  });
});
