/**
 * useAnalytics orchestrator hook tests.
 *
 * Mock 数据库层（getHistoryWithResults）与当前级别（useProficiencyLevel），
 * 覆盖数据获取、类型过滤、时间范围筛选、降级路径、weakCategories 截取与
 * 分技能级别估计的编排接线（原 use-level-analytics.test.ts 的 wiring 用例）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_RECORD_LIMIT, HISTORY_RESULT_LIMIT } from "@/lib/db/history";
import type { HistoryRecord } from "@/types";
import { useAnalytics } from "./index";

const mockGetHistoryWithResults = vi.fn();

// parseDbTimestamp 调用计数（H-02）：包装真实实现，既保留 UTC 解析语义，又能
// 断言"每条记录只解析一次、切换时间范围不重复解析"
const mockParseDbTimestamp = vi.hoisted(() => vi.fn());

// 部分 mock：IPC 函数替换为 vi.fn()，parseDbTimestamp 等纯函数走真实实现——
// 存储时间戳解析语义（UTC 无时区标记）若漂移，本测试第一时间可见
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  mockParseDbTimestamp.mockImplementation(actual.parseDbTimestamp);
  return {
    ...actual,
    parseDbTimestamp: (s: string) => mockParseDbTimestamp(s),
    getHistoryWithResults: (...args: unknown[]) => mockGetHistoryWithResults(...args),
  };
});

// 可变的当前级别持有者：测试按需改写，驱动 buildSuggestions（原
// use-level-analytics.test.ts 的 mock 方式，wiring 用例并入本文件后沿用）
const { mockLevel } = vi.hoisted(() => ({ mockLevel: { current: "B1" } }));
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: mockLevel.current, setLevel: vi.fn() }),
}));

function makeRecord(
  id: number,
  type: HistoryRecord["type"],
  createdAt: string,
  difficultyLevel: string | null = null,
): HistoryRecord {
  return {
    id,
    type,
    input_text: `text-${id}`,
    result: "",
    graph_data: null,
    created_at: createdAt,
    difficulty_level: difficultyLevel,
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

/** 构造合法的 ExerciseResult JSON（score 为答对题数） */
function exerciseJson(score: number, total: number): string {
  return JSON.stringify({
    category: "时态错误",
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
    mockLevel.current = "B1";
    mockGetHistoryWithResults.mockResolvedValue(withResults([], []));
  });

  it("fetches light records + paired results in one call, then clears loading", async () => {
    const { result } = renderHook(() => useAnalytics());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 单次统一调用：六类记录元数据一次取回，
    // 其中仅五类需要解析 result（reading 重型 Markdown result 只供详情页，分析页不拉取）
    // 元数据窗口 500 / 重型 result 只拉最近 150 —— 窗口协议由 useHistoryWindow
    // 单一持有，常量归位 lib/db/history.ts（两处口径不得漂移）
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1);
    expect(mockGetHistoryWithResults).toHaveBeenCalledWith(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      HISTORY_RECORD_LIMIT,
      ["correct", "writing", "exercise", "listening", "speaking"],
      HISTORY_RESULT_LIMIT,
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

  it("parses each record timestamp once and never again when switching time ranges (H-02)", async () => {
    // 100 条阅读记录（无重型 result）：初次加载时精确解析 100 次；
    // 切换时间范围只做数值比较，不再构造 Date
    const toSqlite = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
    const records = Array.from({ length: 100 }, (_, i) =>
      makeRecord(i + 1, "reading", toSqlite(new Date(Date.now() - i * 86400_000))),
    );
    mockGetHistoryWithResults.mockResolvedValue(withResults(records, []));

    const { result, rerender } = renderHook(({ days }) => useAnalytics(days), {
      initialProps: { days: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockParseDbTimestamp).toHaveBeenCalledTimes(records.length);

    mockParseDbTimestamp.mockClear();
    rerender({ days: 7 });

    // 时间范围确实生效，且没有触发任何重复解析
    expect(result.current.allRecords.length).toBeLessThan(records.length);
    expect(mockParseDbTimestamp).not.toHaveBeenCalled();
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

  it("skips records missing from resultById without falling back to record.result", async () => {
    // 轻量查询返回 '' AS result 而非 null，回退永远走不到；即便 record.result
    // 意外带有内容，未命中 resultById 的记录也应被显式跳过
    const record = makeRecord(1, "correct", "2026-07-01T10:00:00");
    record.result = correctionJson(["时态错误"]);
    mockGetHistoryWithResults.mockResolvedValue(withResults([record], []));

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allRecords).toHaveLength(1);
    expect(result.current.totalArticles).toBe(0);
    expect(result.current.totalErrors).toBe(0);
  });

  it("reports resultsWindowLimited=true when the result window hits resultLimit", async () => {
    const records = Array.from({ length: 150 }, (_, i) =>
      makeRecord(i + 1, "correct", "2026-07-01T10:00:00"),
    );
    const pairs = records.map((r) => [r.id, correctionJson(["时态错误"])] as [number, string]);
    mockGetHistoryWithResults.mockResolvedValue(withResults(records, pairs));

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.resultsWindowLimited).toBe(true);
  });

  it("reports resultsWindowLimited=false when results are under the limit, including zero", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults([makeRecord(1, "correct", "2026-07-01T10:00:00")], []),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.resultsWindowLimited).toBe(false);
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

  it("discards a stale response when reload overlaps a slower in-flight load", async () => {
    // 修复 4 回归：连点 reload（或错误态重试）时，慢的旧响应不允许覆盖
    // 新结果——否则界面瞬间回跳到过期数据。useStaleGuard 序号守卫丢弃过期响应。
    const stale = withResults([makeRecord(1, "reading", "2026-07-01T10:00:00")], []);
    const fresh = withResults([makeRecord(2, "reading", "2026-07-02T10:00:00")], []);
    let resolveFirst!: (value: typeof stale) => void;
    let resolveSecond!: (value: typeof fresh) => void;
    mockGetHistoryWithResults
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { result } = renderHook(() => useAnalytics());

    // 初始加载仍在途时触发 reload（连点场景）
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2));

    // 新请求先返回，旧请求后到（乱序）
    await act(async () => {
      resolveSecond(fresh);
    });
    await act(async () => {
      resolveFirst(stale);
    });

    // 过期响应被丢弃：界面停留在第二次加载的数据
    expect(result.current.allRecords.map((r) => r.id)).toEqual([2]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ── 分技能级别估计（原 use-level-analytics.test.ts 的 wiring 用例并入；
  //    use-level-analytics 子 hook 已删除，编排层内联 buildSkillEstimates） ──

  it("returns empty level estimates and suggestions with no data", async () => {
    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.levelEstimates).toEqual([]);
    expect(result.current.levelSuggestions).toEqual([]);
  });

  it("derives an exercise level estimate from the pre-parsed result (buildSkillEstimates wiring)", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(
        [makeRecord(1, "exercise", "2026-07-01T10:00:00", "B2")],
        [[1, exerciseJson(5, 5)]],
      ),
    );

    const { result } = renderHook(() => useAnalytics());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 5/5 满分经 exerciseScorePercent 归一为 100：B2 基准 + adjust +1 → B2+
    const est = result.current.levelEstimates.find((e) => e.skill === "exercise");
    expect(est).toBeDefined();
    expect(est?.level).toBe("B2+");
    // 单样本低置信度，不足以触发建议
    expect(result.current.levelSuggestions).toEqual([]);
  });

  it("drives level suggestions from the current level", async () => {
    // 4 次 B2 满分练习 → 练习估计 B2+（置信度 medium）
    const records = [1, 2, 3, 4].map((i) =>
      makeRecord(i, "exercise", `2026-07-0${i}T10:00:00`, "B2"),
    );
    const pairs = records.map((r) => [r.id, exerciseJson(5, 5)] as [number, string]);
    mockGetHistoryWithResults.mockResolvedValue(withResults(records, pairs));

    // 当前 B1：练习高出多档 → 触发 upgrade-skill
    mockLevel.current = "B1";
    const low = renderHook(() => useAnalytics());
    await waitFor(() => expect(low.result.current.loading).toBe(false));
    expect(low.result.current.levelSuggestions.some((s) => s.kind === "upgrade-skill")).toBe(true);

    // 当前 C1：练习低于当前 → 无建议
    mockLevel.current = "C1";
    const high = renderHook(() => useAnalytics());
    await waitFor(() => expect(high.result.current.loading).toBe(false));
    expect(high.result.current.levelSuggestions).toEqual([]);
  });
});
