/**
 * useHistoryWindow tests —— Analytics 数据窗口单一 owner 的行为契约。
 *
 * 覆盖：单次 getHistoryWithResults 的窗口协议参数、加载成功（records/resultById
 * 透传）、加载失败 fail-soft 暴露 error、reload 换 token 后旧响应被 stale 守卫
 * 丢弃、resultsWindowLimited 阈值两分支、卸载后迟到拒绝不写状态。
 * （此前这套语义在 use-analytics/index.ts 与 use-level-estimation.ts 各自手写
 * 并各测一遍，收敛后只测这一处。）
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_RECORD_LIMIT, HISTORY_RESULT_LIMIT } from "@/lib/db/history";
import type { HistoryRecord } from "@/types";
import { useHistoryWindow } from "./use-history-window";

const mockGetHistoryWithResults = vi.fn();

// 部分 mock：仅替换 getHistoryWithResults，其余走真实实现
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getHistoryWithResults: (...args: unknown[]) => mockGetHistoryWithResults(...args),
}));

/** getHistoryWithResults 的返回结构 */
interface LoadResult {
  records: HistoryRecord[];
  resultById: Map<number, string>;
}

/** 外部可控的 Promise，用于精确编排乱序返回时序（与 use-level-estimation.test.ts 同款） */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function withResults(
  records: HistoryRecord[],
  pairs: Array<[id: number, result: string]>,
): LoadResult {
  return { records, resultById: new Map(pairs) };
}

describe("useHistoryWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHistoryWithResults.mockResolvedValue(withResults([], []));
  });

  it("fetches the shared window protocol in one call and exposes records/resultById", async () => {
    const records = [
      makeRecord(1, "correct", "2026-07-01T10:00:00"),
      makeRecord(2, "exercise", "2026-07-02T10:00:00"),
    ];
    mockGetHistoryWithResults.mockResolvedValue(
      withResults(records, [
        [2, '{"category":"时态错误"}'],
        [1, '{"corrected_text":"c"}'],
      ]),
    );

    const { result } = renderHook(() => useHistoryWindow());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 窗口协议：六类元数据 / 五类 result（reading 只取元数据），
    // 双窗口条数 = lib/db/history 的 HISTORY_RECORD_LIMIT / HISTORY_RESULT_LIMIT
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1);
    expect(mockGetHistoryWithResults).toHaveBeenCalledWith(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      HISTORY_RECORD_LIMIT,
      ["correct", "writing", "exercise", "listening", "speaking"],
      HISTORY_RESULT_LIMIT,
    );

    // records 与 resultById 原样透传（按 id 配对是数据层职责，本 hook 不重组）
    expect(result.current.records.map((r) => r.id)).toEqual([1, 2]);
    expect(result.current.resultById.get(1)).toBe('{"corrected_text":"c"}');
    expect(result.current.resultById.get(2)).toBe('{"category":"时态错误"}');
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load failure as error without throwing (fail-soft)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryWithResults.mockRejectedValue(new Error("db failed"));

    const { result } = renderHook(() => useHistoryWindow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 失败不抛错：错误经 error 字段暴露（调用方渲染错误态而非空态），
    // records 保持空数组、窗口旗标自然为 false
    expect(result.current.error).toContain("db failed");
    expect(result.current.records).toEqual([]);
    expect(result.current.resultsWindowLimited).toBe(false);
    warnSpy.mockRestore();
  });

  it("clears a previous error after a successful reload (retry path)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryWithResults.mockRejectedValueOnce(new Error("db failed"));

    const { result } = renderHook(() => useHistoryWindow());
    await waitFor(() => expect(result.current.error).toContain("db failed"));

    mockGetHistoryWithResults.mockResolvedValue(withResults([], []));
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("discards a stale earlier response when reload overlaps a slower in-flight load", async () => {
    // 连点 reload：慢的第一次加载晚到——effect 重跑时 cleanup 的 begin() 已使
    // 它过期，不得写坏第二次加载的状态
    const stale = withResults([makeRecord(1, "reading", "2026-07-01T10:00:00")], []);
    const fresh = withResults([makeRecord(2, "reading", "2026-07-02T10:00:00")], []);
    const first = deferred<LoadResult>();
    const second = deferred<LoadResult>();
    mockGetHistoryWithResults
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useHistoryWindow());

    // 初始加载仍在途时触发 reload（连点场景）
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2));

    // 新请求先返回，旧请求后到（乱序）
    await act(async () => {
      second.resolve(fresh);
    });
    await act(async () => {
      first.resolve(stale);
    });

    // 过期响应被丢弃：数据归第二次加载所有
    expect(result.current.records.map((r) => r.id)).toEqual([2]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("drops a late rejection after unmount (cleanup invalidates it)", async () => {
    // 卸载语义：effect cleanup 主动 begin() 使在途响应过期——迟到 reject
    // 既不写 error 也不打 console.warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = deferred<LoadResult>();
    mockGetHistoryWithResults.mockImplementationOnce(() => pending.promise);

    const { unmount } = renderHook(() => useHistoryWindow());
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      pending.reject(new Error("db failed"));
      // 冲刷微任务，让 reject 走到 catch 分支
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("flags resultsWindowLimited=true when resultById reaches HISTORY_RESULT_LIMIT", async () => {
    // 恰好取满 result 窗口即视为可能截断（恰为上限时无法区分是否还有更多），
    // UI 据此披露趋势/估计基于最近 N 条详细结果
    const records = Array.from({ length: HISTORY_RESULT_LIMIT }, (_, i) =>
      makeRecord(i + 1, "exercise", "2026-07-01T10:00:00"),
    );
    const pairs = records.map((r) => [r.id, '{"category":"时态错误"}'] as [number, string]);
    mockGetHistoryWithResults.mockResolvedValue(withResults(records, pairs));

    const { result } = renderHook(() => useHistoryWindow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.resultsWindowLimited).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("keeps resultsWindowLimited=false under the limit, including zero results", async () => {
    mockGetHistoryWithResults.mockResolvedValue(
      withResults([makeRecord(1, "correct", "2026-07-01T10:00:00")], []),
    );

    const { result } = renderHook(() => useHistoryWindow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.resultsWindowLimited).toBe(false);
  });
});
