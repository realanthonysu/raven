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
    // 四类需要解析 result 的记录按需获取；写作取 correct + legacy writing 两种 type
    expect(mockGetHistoryResultsByType).toHaveBeenCalledWith(["correct", "writing"], 500);
    expect(mockGetHistoryResultsByType).toHaveBeenCalledWith(["exercise"], 500);
    expect(mockGetHistoryResultsByType).toHaveBeenCalledWith(["listening"], 500);
    expect(mockGetHistoryResultsByType).toHaveBeenCalledWith(["speaking"], 500);
    expect(mockGetHistoryResultsByType).toHaveBeenCalledTimes(4);
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
    mockGetHistoryResultsByType.mockImplementation((types: string[]) =>
      types.includes("correct")
        ? Promise.resolve([
            { id: 1, result: correctionJson(["时态错误", "拼写错误"]) },
            { id: 2, result: correctionJson(["时态错误"]) },
          ])
        : Promise.resolve([]),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.totalArticles).toBe(2);
    expect(result.current.totalErrors).toBe(3);
    expect(result.current.avgErrors).toBe("1.5");
    expect(result.current.categoryData[0]).toEqual({ name: "时态错误", count: 2 });
  });

  it("pairs results by record id, immune to legacy 'writing' type and result order (P0 regression)", async () => {
    // 回归：correctRecords 含 correct 与 legacy writing 两种 type；此前 result 查询只取
    // correct 且按数组下标配对，混型后所有配对整体错位。现在返回 (id, result) 对，
    // 即使结果数组顺序与记录列表相反也应正确配对。
    mockGetHistoryList.mockResolvedValue([
      makeRecord(1, "correct", "2026-07-01T10:00:00"),
      makeRecord(2, "writing", "2026-07-02T10:00:00"), // legacy type
      makeRecord(3, "writing", "2026-07-03T10:00:00"), // legacy type
    ]);
    // 故意按与记录列表相反的顺序返回，验证按 id（而非下标）配对
    mockGetHistoryResultsByType.mockImplementation((types: string[]) =>
      types.includes("correct")
        ? Promise.resolve([
            { id: 3, result: correctionJson(["拼写错误"]) }, // 1 个错误
            { id: 2, result: correctionJson(["时态错误", "时态错误"]) }, // 2 个错误
            { id: 1, result: correctionJson(["时态错误", "时态错误", "时态错误"]) }, // 3 个错误
          ])
        : Promise.resolve([]),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 三条记录都参与统计（legacy writing 不再被 result 查询漏掉）
    expect(result.current.totalArticles).toBe(3);
    // 按下标配对会把 id=1 配到 1 个错误 —— 按 id 配对才能得到正确的 6
    expect(result.current.totalErrors).toBe(6);
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
    mockGetHistoryResultsByType.mockImplementation((types: string[]) =>
      types.includes("correct")
        ? Promise.resolve([
            {
              id: 1,
              result: correctionJson(["时态错误", "时态错误", "拼写错误", "拼写错误", "冠词错误"]),
            },
          ])
        : Promise.resolve([]),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.weakCategories).toHaveLength(2);
    expect(result.current.weakCategories.map((c) => c.name)).toEqual(["时态错误", "拼写错误"]);
  });
});
