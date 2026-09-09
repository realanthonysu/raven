/**
 * useAnalytics orchestrator hook tests.
 *
 * Mock 数据库层（getHistoryWithResults），
 * 覆盖数据获取、类型过滤、时间范围筛选、降级路径与 weakCategories 截取。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";
import { useAnalytics } from "./index";

const mockGetHistoryWithResults = vi.fn();

vi.mock("@/lib/db", () => ({
  getHistoryWithResults: (...args: unknown[]) => mockGetHistoryWithResults(...args),
  // 子 hook 依赖的日期解析工具（与真实实现一致：history.created_at 为 UTC，
  // 空格分隔的 SQLite 格式替换为 T 并补 "Z" 后按 UTC 解析）
  parseDbTimestamp: (s: string) => new Date(`${s.includes(" ") ? s.replace(" ", "T") : s}Z`),
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

/** 构造 getHistoryWithResults 的成功返回值 */
function withResults(
  records: HistoryRecord[],
  pairs: Array<[id: number, result: string]>,
): { records: HistoryRecord[]; resultById: Map<number, string> } {
  return { records, resultById: new Map(pairs) };
}

describe("useAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHistoryWithResults.mockResolvedValue(withResults([], []));
  });

  it("fetches light records + paired results in one call, then clears loading", async () => {
    const { result } = renderHook(() => useAnalytics());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 单次统一调用：六类记录元数据一次取回，
    // 其中仅五类需要解析 result（reading 重型 Markdown result 只供详情页，分析页不拉取）
    // resultLimit=150：元数据窗口 500，重型 result 只拉最近 150，压低 IPC
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1);
    expect(mockGetHistoryWithResults).toHaveBeenCalledWith(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      500,
      ["correct", "writing", "exercise", "listening", "speaking"],
      150,
    );
  });

  it("filters records by type, treating legacy 'writing' as correct", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(
        [
          makeRecord(1, "correct", "2026-07-01T10:00:00"),
          makeRecord(2, "writing", "2026-07-02T10:00:00"),
          makeRecord(3, "exercise", "2026-07-03T10:00:00"),
          makeRecord(4, "listening", "2026-07-04T10:00:00"),
          makeRecord(5, "reading", "2026-07-05T10:00:00"),
          makeRecord(6, "speaking", "2026-07-06T10:00:00"),
        ],
        [],
      ),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(6);
    expect(result.current.correctRecords.map((r) => r.id)).toEqual([1, 2]);
    expect(result.current.exerciseRecords.map((r) => r.id)).toEqual([3]);
    expect(result.current.listeningRecords.map((r) => r.id)).toEqual([4]);
    expect(result.current.readingRecords.map((r) => r.id)).toEqual([5]);
    expect(result.current.speakingRecords.map((r) => r.id)).toEqual([6]);
  });

  it("aggregates writing analytics from paired result strings", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(
        [
          makeRecord(1, "correct", "2026-07-01T10:00:00"),
          makeRecord(2, "correct", "2026-07-02T10:00:00"),
        ],
        [
          [1, correctionJson(["时态错误", "拼写错误"])],
          [2, correctionJson(["时态错误"])],
        ],
      ),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.totalArticles).toBe(2);
    expect(result.current.totalErrors).toBe(3);
    expect(result.current.avgErrors).toBe("1.5");
    expect(result.current.categoryData[0]).toEqual({ name: "时态错误", count: 2 });
  });

  it("pairs results by record id, immune to legacy 'writing' type and map insertion order (P0 regression)", async () => {
    // 回归：correctRecords 含 correct 与 legacy writing 两种 type；此前按数组下标配对，
    // 混型后所有配对整体错位。resultById 以 id 为键，插入顺序无关也能正确配对。
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(
        [
          makeRecord(1, "correct", "2026-07-01T10:00:00"),
          makeRecord(2, "writing", "2026-07-02T10:00:00"), // legacy type
          makeRecord(3, "writing", "2026-07-03T10:00:00"), // legacy type
        ],
        [
          [3, correctionJson(["拼写错误"])], // 1 个错误
          [2, correctionJson(["时态错误", "时态错误"])], // 2 个错误
          [1, correctionJson(["时态错误", "时态错误", "时态错误"])], // 3 个错误
        ],
      ),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 三条记录都参与统计（legacy writing 不再被 result 查询漏掉）
    expect(result.current.totalArticles).toBe(3);
    // 按下标配对会把 id=1 配到 1 个错误 —— 按 id 配对才能得到正确的 6
    expect(result.current.totalErrors).toBe(6);
  });

  it("filters records by days when time range is set", async () => {
    // 用 SQLite 真实格式（"YYYY-MM-DD HH:MM:SS"，UTC）构造 fixtures，与
    // parseDbTimestamp 的 UTC 解析语义一致
    const toSqlite = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
    const recent = toSqlite(new Date(Date.now() - 1 * 86400_000));
    const old = toSqlite(new Date(Date.now() - 30 * 86400_000));
    mockGetHistoryWithResults.mockResolvedValue(
      withResults([makeRecord(1, "reading", recent), makeRecord(2, "reading", old)], []),
    );

    const { result, rerender } = renderHook(({ days }) => useAnalytics(days), {
      initialProps: { days: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(2);

    rerender({ days: 7 });
    expect(result.current.allRecords.map((r) => r.id)).toEqual([1]);
  });

  it("degrades gracefully when results are missing (fail-soft empty Map)", async () => {
    // 契约：getHistoryWithResults 内部承接了 result 拉取失败的降级 ——
    // 记录照常返回、resultById 为空 Map，页面仍渲染（仅统计数据为空）
    mockGetHistoryWithResults.mockResolvedValue(
      withResults([makeRecord(1, "correct", "2026-07-01T10:00:00")], []),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(1);
    expect(result.current.totalArticles).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it("surfaces an error and keeps empty records when the unified query fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryWithResults.mockRejectedValue(new Error("db failed"));

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toEqual([]);
    expect(result.current.error).toContain("db failed");
    warnSpy.mockRestore();
  });

  it("limits weakCategories to top 2 after mastery weighting", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(
        [makeRecord(1, "correct", "2026-07-01T10:00:00")],
        [[1, correctionJson(["时态错误", "时态错误", "拼写错误", "拼写错误", "冠词错误"])]],
      ),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.weakCategories).toHaveLength(2);
    expect(result.current.weakCategories.map((c) => c.name)).toEqual(["时态错误", "拼写错误"]);
  });

  it("reloads data when reload is called", async () => {
    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2));
  });
});
