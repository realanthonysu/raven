/**
 * use-level-estimation tests.
 *
 * 覆盖共享归一化核心：
 * - collectSkillEstimates 纯函数：练习百分制换算、difficulty_level 回退、
 *   防御性（新→旧）排序（含同秒 id 降序兜底）、样本不足/无效样本丢弃、
 *   写作 band、阅读元数据、建议触发；
 * - useLevelEstimation hook：加载/刷新/fail-soft（DB 层 mock），
 *   窗口常量与 Analytics 单一来源（500/150）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEVEL_ESTIMATE_RECORD_LIMIT, LEVEL_ESTIMATE_RESULT_LIMIT } from "@/lib/level-estimation";
import type { LevelCode } from "@/lib/levels";
import type { HistoryRecord } from "@/types";
import { collectSkillEstimates, useLevelEstimation } from "./use-level-estimation";

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

/** 合法 ListeningResult JSON（score 0-100，difficulty 为回退来源） */
function listenJson(score: number, difficulty = "B2"): string {
  return JSON.stringify({
    difficulty,
    topic: "日常对话",
    sentences: [{ text: "s", hint: "h" }],
    userInputs: [""],
    score,
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
    const { estimates } = collect(records, [[1, listenJson(90, "B2")]]);
    const li = estimates.find((e) => e.skill === "listening");
    expect(li).toBeDefined();
    // B2 起算 + score 90(adjust +1) → B2+
    expect(li?.level).toBe("B2+");
  });

  it("drops samples whose level cannot be resolved (old non-CEFR difficulty)", () => {
    const records = [rec(1, "listening", "2026-07-01T10:00:00", null)];
    const { estimates } = collect(records, [[1, listenJson(90, "初级")]]);
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
    // 4 次练习 + 4 次听力，均 B2、满分 → 两个技能估计 B2+（置信度 medium）
    for (let i = 0; i < 4; i++) {
      records.push(rec(id, "exercise", `2026-07-0${i + 1}T10:00:00`, "B2"));
      pairs.push([id, exJson(5, 5)]);
      id++;
    }
    for (let i = 0; i < 4; i++) {
      records.push(rec(id, "listening", `2026-07-0${i + 1}T10:00:00`, "B2"));
      pairs.push([id, listenJson(100, "B2")]);
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
    // 记录窗口 500 / result 窗口 150 —— 与 Analytics 共用 level-estimation.ts
    // 的同一对常量（D1-7：两处窗口口径不得漂移）
    expect(mockGetHistoryWithResults).toHaveBeenCalledWith(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      LEVEL_ESTIMATE_RECORD_LIMIT,
      ["correct", "writing", "exercise", "listening", "speaking"],
      LEVEL_ESTIMATE_RESULT_LIMIT,
    );
    expect(result.current.estimates.find((e) => e.skill === "exercise")).toBeDefined();
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
    warnSpy.mockRestore();
  });
});
