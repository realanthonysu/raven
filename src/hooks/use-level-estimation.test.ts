/**
 * use-level-estimation tests.
 *
 * 覆盖共享归一化核心（f11 后纯函数居于 lib/level-estimation-samples，本文件
 * 经 import 复用其测试）：
 * - collectSkillEstimates 纯函数：练习百分制换算、听力百分制换算、
 *   difficulty_level 回退、
 *   防御性（新→旧）排序（含同秒 id 降序兜底）、样本不足/无效样本丢弃、
 *   写作 band、阅读元数据、建议触发；
 * - useLevelEstimation hook：加载/刷新/fail-soft（DB 层 mock）、
 *   加载失败经 error 暴露（不伪装成"数据不足"）、result 窗口截断标志
 *   （与 Analytics 同一 useHistoryWindow 同口径）、窗口常量单一来源
 *   （lib/db/history.ts 的 500/150）、stale-response 守卫（refresh 后慢的
 *   旧加载晚到不覆盖新数据、卸载后迟到响应被 cleanup 作废）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_RECORD_LIMIT, HISTORY_RESULT_LIMIT } from "@/lib/db/history";
// 纯归一化核心已拆至 lib/level-estimation-samples（f11）：测试随之改从该模块
// import，hook 自身只覆盖 React 生命周期（加载/刷新/fail-soft/stale 守卫）
import { collectSkillEstimates } from "@/lib/level-estimation-samples";
import type { LevelCode } from "@/lib/levels";
import type { HistoryRecord } from "@/types";
import { useLevelEstimation } from "./use-level-estimation";

const mockGetHistoryWithResults = vi.fn();
// DB 层部分 mock：仅替换 getHistoryWithResults，parseDbTimestamp 等走真实实现
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getHistoryWithResults: (...args: unknown[]) => mockGetHistoryWithResults(...args),
}));
// 固定当前级别，隔离全局 store 的 DB 水合
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: "B1", setLevel: vi.fn() }),
}));

/** getHistoryWithResults 的返回结构（本测试只消费 records/resultById 两字段） */
interface LoadResult {
  records: HistoryRecord[];
  resultById: Map<number, string>;
}

/** 外部可控的 Promise，用于精确编排乱序返回时序（与 use-graph-data.test.ts 同款） */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rec(
  id: number,
  type: HistoryRecord["type"],
  createdAt: string,
  difficultyLevel: string | null = "B1",
): HistoryRecord {
  return {
    id,
    type,
    input_text: "t",
    result: "",
    graph_data: null,
    created_at: createdAt,
    difficulty_level: difficultyLevel,
  };
}

/** 合法 ExerciseResult JSON（score 为答对题数，无 difficulty 字段） */
function exJson(score: number, total: number): string {
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

/** 合法 ListeningResult JSON（score 为答对句数，difficulty 为回退来源） */
function listenJson(correct: number, difficulty = "B2", total = 5): string {
  return JSON.stringify({
    difficulty,
    topic: "日常对话",
    sentences: Array.from({ length: total }, (_, i) => ({ text: `s${i}`, hint: "h" })),
    userInputs: Array.from({ length: total }, () => ""),
    score: correct,
  });
}

/** 合法 CorrectionResult JSON（可带 level_estimate.band） */
function correctionJson(band: string): string {
  return JSON.stringify({
    corrected_text: "c",
    corrections: [],
    summary: "s",
    level_estimate: { band, rationale: "r" },
  });
}

function collect(
  records: HistoryRecord[],
  pairs: Array<[number, string]>,
  current: LevelCode = "B1",
) {
  return collectSkillEstimates(records, new Map(pairs), current);
}

describe("collectSkillEstimates", () => {
  it("returns empty estimates and suggestions for no data", () => {
    const { estimates, suggestions } = collect([], []);
    expect(estimates).toEqual([]);
    expect(suggestions).toEqual([]);
  });

  it("converts exercise raw score to percentage (avgScore reflects 0-100)", () => {
    const records = [rec(1, "exercise", "2026-07-01T10:00:00", "B1")];
    const { estimates } = collect(records, [[1, exJson(8, 10)]]);
    const ex = estimates.find((e) => e.skill === "exercise");
    expect(ex).toBeDefined();
    // 8/10 → 80（而非原始 8）
    expect(ex?.avgScore).toBe(80);
  });

  it("drops exercise samples with zero questions", () => {
    const records = [rec(1, "exercise", "2026-07-01T10:00:00", "B2")];
    const { estimates } = collect(records, [[1, exJson(0, 0)]]);
    expect(estimates.find((e) => e.skill === "exercise")).toBeUndefined();
  });

  it("falls back to result.difficulty when record.difficulty_level is missing", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", null)];
    const { estimates } = collect(records, [[1, listenJson(5, "B2")]]);
    const li = estimates.find((e) => e.skill === "listening");
    expect(li).toBeDefined();
    // B2 起算 + 归一后 100 分(adjust +1) → B2+
    expect(li?.level).toBe("B2+");
  });

  it("drops samples whose level cannot be resolved (old non-CEFR difficulty)", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", null)];
    const { estimates } = collect(records, [[1, listenJson(5, "初级")]]);
    expect(estimates.find((e) => e.skill === "listening")).toBeUndefined();
  });

  it("normalizes listening raw score to percent (5/5 at B1 is not underestimated)", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", "B1")];
    const { estimates } = collect(records, [[1, listenJson(5, "B2", 5)]]);
    const li = estimates.find((e) => e.skill === "listening");
    expect(li).toBeDefined();
    // 5/5 归一为 100 分：B1 基准 + adjust +1 → B1+。
    // 旧实现把答对句数 5 当百分制，avgScore=5 → adjust -1 → A2（低估两档）。
    expect(li?.level).toBe("B1+");
    expect(li?.avgScore).toBe(100);
  });

  it("estimates B2+ for a perfect B2 listening session (5/5 → 100)", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", "B2")];
    const { estimates } = collect(records, [[1, listenJson(5, "B2", 5)]]);
    const li = estimates.find((e) => e.skill === "listening");
    expect(li).toBeDefined();
    // 满分不得因原始分被当百分制而低估：B2 基准 + adjust +1 → B2+
    // （旧实现 avgScore=5 → B1+）
    expect(li?.level).toBe("B2+");
  });

  it("estimates B1 for 4/5 at B1 (avgScore 80 → adjust 0)", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", "B1")];
    const { estimates } = collect(records, [[1, listenJson(4, "B2", 5)]]);
    const li = estimates.find((e) => e.skill === "listening");
    expect(li).toBeDefined();
    expect(li?.avgScore).toBe(80);
    expect(li?.level).toBe("B1");
  });

  it("drops listening samples with zero sentences", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", "B2")];
    const { estimates } = collect(records, [[1, listenJson(0, "B2", 0)]]);
    expect(estimates.find((e) => e.skill === "listening")).toBeUndefined();
  });

  it("sorts scored samples newest-first by created_at regardless of input order", () => {
    const older = rec(1, "exercise", "2026-07-01T10:00:00", "A2");
    const newer = rec(2, "exercise", "2026-07-02T10:00:00", "B2");
    const pairs: Array<[number, string]> = [
      [1, exJson(5, 5)],
      [2, exJson(5, 5)],
    ];
    // 未排序会用数组序 [A2, B2] 得 B1+；防御性排序后按 [B2, A2] 得 B2。
    // 两种传入顺序结果一致且为 B2，证明按 created_at 新→旧重排生效。
    const a = collect([older, newer], pairs).estimates.find((e) => e.skill === "exercise");
    const b = collect([newer, older], pairs).estimates.find((e) => e.skill === "exercise");
    expect(a?.level).toBe("B2");
    expect(b?.level).toBe("B2");
  });

  it("breaks created_at ties by id descending (same-second writes)", () => {
    // 同一秒写入：id 大者更新（防御性排序的兜底分支，保证排序确定）
    const older = rec(1, "exercise", "2026-07-01T10:00:00", "A2");
    const newer = rec(2, "exercise", "2026-07-01T10:00:00", "B2");
    const pairs: Array<[number, string]> = [
      [1, exJson(5, 5)],
      [2, exJson(5, 5)],
    ];
    // 若兜底方向错（id 升序 → [A2, B2]），结果会是 B1+ 而非 B2
    const a = collect([older, newer], pairs).estimates.find((e) => e.skill === "exercise");
    const b = collect([newer, older], pairs).estimates.find((e) => e.skill === "exercise");
    expect(a?.level).toBe("B2");
    expect(b?.level).toBe("B2");
  });

  it("estimates writing from level_estimate.band (avgScore null)", () => {
    const records = [rec(1, "correct", "2026-07-01T10:00:00", "B1")];
    const { estimates } = collect(records, [[1, correctionJson("B2+")]]);
    const wr = estimates.find((e) => e.skill === "writing");
    expect(wr).toBeDefined();
    expect(wr?.level).toBe("B2+");
    expect(wr?.avgScore).toBeNull();
  });

  it("ignores writing bands that are not valid level codes", () => {
    const records = [rec(1, "correct", "2026-07-01T10:00:00", "B1")];
    const { estimates } = collect(records, [[1, correctionJson("C2")]]);
    expect(estimates.find((e) => e.skill === "writing")).toBeUndefined();
  });

  it("estimates reading from difficulty_level metadata, dropping null levels", () => {
    const withLevel = rec(1, "reading", "2026-07-01T10:00:00", "B2");
    const noLevel = rec(2, "reading", "2026-07-02T10:00:00", null);
    const { estimates } = collect([withLevel, noLevel], []);
    const rd = estimates.find((e) => e.skill === "reading");
    expect(rd).toBeDefined();
    expect(rd?.sampleSize).toBe(1);
  });

  it("emits an upgrade-global suggestion when two skills qualify above current", () => {
    const records: HistoryRecord[] = [];
    const pairs: Array<[number, string]> = [];
    let id = 1;
    // 4 次练习 + 4 次听力，均 B2、满分（听力 5/5 归一为 100）→ 两个技能估计 B2+（置信度 medium）
    for (let i = 0; i < 4; i++) {
      records.push(rec(id, "exercise", `2026-07-0${i + 1}T10:00:00`, "B2"));
      pairs.push([id, exJson(5, 5)]);
      id++;
    }
    for (let i = 0; i < 4; i++) {
      records.push(rec(id, "listening", `2026-07-0${i + 1}T10:00:00`, "B2"));
      pairs.push([id, listenJson(5, "B2")]);
      id++;
    }
    const { suggestions } = collect(records, pairs, "B1");
    const global = suggestions.find((s) => s.kind === "upgrade-global");
    expect(global).toBeDefined();
    expect(global?.targetLevel).toBe("B2+");
  });

  it("emits no suggestions when the only estimate is low-confidence below current", () => {
    const records = [rec(1, "exercise", "2026-07-01T10:00:00", "B1")];
    const { estimates, suggestions } = collect(records, [[1, exJson(3, 5)]], "C1");
    expect(estimates.find((e) => e.skill === "exercise")).toBeDefined();
    expect(suggestions).toEqual([]);
  });
});

describe("useLevelEstimation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHistoryWithResults.mockResolvedValue({ records: [], resultById: new Map() });
  });

  it("loads records + paired results in one call and computes estimates", async () => {
    const records = [rec(1, "exercise", "2026-07-01T10:00:00", "B2")];
    mockGetHistoryWithResults.mockResolvedValue({
      records,
      resultById: new Map([[1, exJson(5, 5)]]),
    });

    const { result } = renderHook(() => useLevelEstimation());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 六类元数据一次取回，仅五类拉取重型 result（reading 只取元数据）；
    // 记录窗口 500 / result 窗口 150 —— 窗口协议由 useHistoryWindow 单一持有，
    // 常量归位 lib/db/history.ts（两处口径不得漂移）
    expect(mockGetHistoryWithResults).toHaveBeenCalledWith(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      HISTORY_RECORD_LIMIT,
      ["correct", "writing", "exercise", "listening", "speaking"],
      HISTORY_RESULT_LIMIT,
    );
    expect(result.current.estimates.find((e) => e.skill === "exercise")).toBeDefined();
    // 加载成功：无错误、result 数远低于窗口上限 → 未截断
    expect(result.current.error).toBeNull();
    expect(result.current.resultsWindowLimited).toBe(false);
  });

  it("re-fetches when refresh is called", async () => {
    const { result } = renderHook(() => useLevelEstimation());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2));
  });

  it("fails soft to empty estimates on load error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryWithResults.mockRejectedValue(new Error("db fail"));

    const { result } = renderHook(() => useLevelEstimation());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.estimates).toEqual([]);
    expect(result.current.suggestions).toEqual([]);
    // 失败不再只能靠 console.warn：error 字段暴露给调用方渲染错误态 + 重试，
    // 避免加载失败被伪装成"练习数据不足"（f5）
    expect(result.current.error).toBe("db fail");
    expect(result.current.resultsWindowLimited).toBe(false);
    warnSpy.mockRestore();
  });

  it("flags the result window as limited when it hits the cap (same 口径 as Analytics)", async () => {
    // 恰好取满 result 窗口即视为可能截断（与 useAnalytics 同口径：恰为上限时
    // 无法区分是否还有更多），UI 据此披露估计基于最近 N 条详细结果（f6）
    const records = Array.from({ length: HISTORY_RESULT_LIMIT }, (_, i) =>
      rec(i + 1, "exercise", "2026-07-01T10:00:00", "B1"),
    );
    const pairs: Array<[number, string]> = records.map((r) => [r.id, exJson(5, 5)]);
    mockGetHistoryWithResults.mockResolvedValue({
      records,
      resultById: new Map(pairs),
    });

    const { result } = renderHook(() => useLevelEstimation());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.resultsWindowLimited).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("clears a previous error after a successful refresh (retry path)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetHistoryWithResults.mockRejectedValueOnce(new Error("db fail"));

    const { result } = renderHook(() => useLevelEstimation());
    await waitFor(() => expect(result.current.error).toBe("db fail"));

    // 重试成功：error 清空（effect 重跑时先 setError(null)，成功后保持 null）
    mockGetHistoryWithResults.mockResolvedValue({ records: [], resultById: new Map() });
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.estimates).toEqual([]);
    warnSpy.mockRestore();
  });

  // ── stale-response 守卫（f10：与 useGraphData 共用 useStaleGuard） ──────

  it("discards a slow earlier load that lands after refresh", async () => {
    // 乱序响应：refresh 后慢的第一次加载晚到——effect 重跑时 cleanup 的
    // begin() 已使它过期，不得写坏第二次加载的状态；第二次落地后数据归它所有
    const first = deferred<LoadResult>();
    const second = deferred<LoadResult>();
    mockGetHistoryWithResults
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useLevelEstimation());

    // 第一次在途时 refresh：effect 重跑（cleanup begin() → 新 effect begin()）
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(2));

    // 慢的旧加载晚到：过期即整体丢弃——records/error 不动，loading 仍归第二次
    await act(async () => {
      first.resolve({
        records: [rec(1, "exercise", "2026-07-01T10:00:00", "A2")],
        resultById: new Map(),
      });
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.estimates).toEqual([]);
    expect(result.current.error).toBeNull();

    // 第二次正常落地：新数据保留（旧响应没有覆盖它）。
    // B2 + 满分（5/5 → 100）→ adjust +1 → B2+（与听力满分同口径）
    await act(async () => {
      second.resolve({
        records: [rec(2, "exercise", "2026-07-02T10:00:00", "B2")],
        resultById: new Map([[2, exJson(5, 5)]]),
      });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.estimates.find((e) => e.skill === "exercise")?.level).toBe("B2+");
  });

  it("discards a late rejection after unmount (cleanup invalidates it)", async () => {
    // 卸载语义：effect cleanup 主动 begin() 使在途响应过期（保留原 cancelled
    // 守卫的卸载丢弃行为）——迟到 reject 既不写 error 也不打 console.warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = deferred<LoadResult>();
    mockGetHistoryWithResults.mockImplementationOnce(() => pending.promise);

    const { unmount } = renderHook(() => useLevelEstimation());
    await waitFor(() => expect(mockGetHistoryWithResults).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      pending.reject(new Error("db fail"));
      // 冲刷微任务，让 reject 走到 catch 分支
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 迟到错误被丢弃：console.warn 一次都不该出现（守卫失效则会打点）
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
