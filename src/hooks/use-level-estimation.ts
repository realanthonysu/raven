/**
 * 被动级别估计 —— 共享归一化核心 + 独立加载 hook（Phase 4 被动定级 /
 * Phase 3 分技能雷达共用）。
 *
 * 两层结构：
 * - `buildSkillEstimates(inputs, currentLevel)`：纯函数核心。输入是调用方
 *   已按类型分好组、且已解析好 result 的样本（记录 + 结果配对），负责
 *   归一化（练习百分制换算、level 解析与回退、band 过滤、防御性排序）后
 *   喂给 lib/level-estimation 的估计引擎，并产出升级建议。
 *   LevelCard 的独立加载与 Analytics 子 hook 都复用这一层，保证两处口径一致。
 * - `collectSkillEstimates(records, resultById, currentLevel)`：在核心之上
 *   包一层「原始记录 + result 字符串 → 解析分组」，供未做预解析的调用方
 *   （useLevelEstimation hook）使用；Analytics 侧已由编排层 parsedAll 预解析，
 *   直接走 buildSkillEstimates，不再重复 JSON.parse。
 *
 * 归一化约定（与 lib/level-estimation 的样本契约对齐）：
 * - 计分技能样本必须按新 → 旧排列（时间衰减 0.85^i 假设 i=0 为最新），
 *   故估计前统一按 created_at 降序重排，不信任调用方传入顺序。
 * - 级别解析优先 record.difficulty_level，缺省回退 result.difficulty，
 *   均经 isLevelCode 校验（旧数据"初级/中级/高级"与越界值被剔除）。
 */

import { useEffect, useMemo, useState } from "react";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { getHistoryWithResults, parseDbTimestamp } from "@/lib/db";
import {
  type BandSample,
  buildSuggestions,
  estimateFromBands,
  estimateFromLevels,
  estimateFromScored,
  LEVEL_ESTIMATE_RECORD_LIMIT,
  LEVEL_ESTIMATE_RESULT_LIMIT,
  type LevelSample,
  type LevelUpSuggestion,
  type ScoredSample,
  type SkillEstimate,
} from "@/lib/level-estimation";
import { isLevelCode, type LevelCode } from "@/lib/levels";
import { extractJsonSafe } from "@/lib/parse-utils";
import {
  CorrectionResultSchema,
  ExerciseResultSchema,
  ListeningResultSchema,
  SpeakingResultSchema,
} from "@/lib/schemas";
import type {
  CorrectionResult,
  ExerciseResult,
  HistoryRecord,
  ListeningResult,
  SpeakingResult,
} from "@/types";

/** 记录 + 已解析 result 的配对（与 useAnalytics 编排层 parsedAll 的元素同构）。 */
interface ParsedPair<T> {
  record: HistoryRecord;
  result: T;
}

/**
 * buildSkillEstimates 的输入 —— 各技能已分好组、已解析好 result 的样本。
 * reading 只取 difficulty_level 元数据，故为裸记录（无 result）。
 */
export interface LevelEstimationInputs {
  correct: ParsedPair<CorrectionResult>[];
  exercise: ParsedPair<ExerciseResult>[];
  listening: ParsedPair<ListeningResult>[];
  speaking: ParsedPair<SpeakingResult>[];
  reading: HistoryRecord[];
}

/** 新 → 旧排序：created_at 降序，同秒用 id 降序兜底，保证排序确定。 */
function byNewestFirstRecord(a: HistoryRecord, b: HistoryRecord): number {
  const t = parseDbTimestamp(b.created_at).getTime() - parseDbTimestamp(a.created_at).getTime();
  return t !== 0 ? t : b.id - a.id;
}

/**
 * 解析样本级别：优先 record.difficulty_level，缺省回退 result.difficulty；
 * 两者经 isLevelCode 校验，都无则返回 null（调用方据此丢弃样本）。
 */
function resolveLevel(record: HistoryRecord, resultDifficulty?: string): LevelCode | null {
  if (isLevelCode(record.difficulty_level)) return record.difficulty_level;
  if (resultDifficulty !== undefined && isLevelCode(resultDifficulty)) return resultDifficulty;
  return null;
}

/**
 * 计分技能（练习/听力/口语）共用的样本收集：剔除无级别或无有效得分的样本，
 * 按新 → 旧排序后映射为 ScoredSample。
 */
function collectScored(
  entries: Array<{ record: HistoryRecord; level: LevelCode | null; score: number | null }>,
): ScoredSample[] {
  return entries
    .filter(
      (e): e is { record: HistoryRecord; level: LevelCode; score: number } =>
        e.level !== null && e.score !== null,
    )
    .sort((a, b) => byNewestFirstRecord(a.record, b.record))
    .map((e) => ({ level: e.level, score: e.score }));
}

/**
 * 由已分组建好的样本计算各技能估计与升级建议（纯函数，无 I/O）。
 *
 * 归一化要点：
 * - 写作：取 level_estimate.band（旧数据无该字段即丢弃样本），无得分微调。
 * - 阅读：仅 difficulty_level 元数据，无得分，置信度封顶 medium。
 * - 练习：score 为答对题数，需 /exercises.length × 100 归一为百分制；
 *   length=0 视为无有效得分，丢弃该样本。
 * - 听力/口语：score / averageScore 本身即 0-100，直接作为得分。
 *
 * @param inputs - 各技能已解析好的样本
 * @param currentLevel - 当前全局级别（建议生成的基准）
 * @returns 各技能估计（按 写作/阅读/练习/听力/口语 顺序）与升级建议
 */
export function buildSkillEstimates(
  inputs: LevelEstimationInputs,
  currentLevel: LevelCode,
): { estimates: SkillEstimate[]; suggestions: LevelUpSuggestion[] } {
  const estimates: SkillEstimate[] = [];

  // 写作：level_estimate.band 样本
  const writingSamples: BandSample[] = inputs.correct
    .map(({ record, result }) => ({ record, band: result.level_estimate?.band }))
    .filter((s): s is { record: HistoryRecord; band: LevelCode } => isLevelCode(s.band))
    .sort((a, b) => byNewestFirstRecord(a.record, b.record))
    .map((s) => ({ band: s.band }));
  const writing = estimateFromBands(writingSamples);
  if (writing) estimates.push(writing);

  // 阅读：仅难度级别元数据
  const readingSamples: LevelSample[] = inputs.reading
    .filter((r): r is HistoryRecord & { difficulty_level: LevelCode } =>
      isLevelCode(r.difficulty_level),
    )
    .sort(byNewestFirstRecord)
    .map((r) => ({ level: r.difficulty_level }));
  const reading = estimateFromLevels(readingSamples);
  if (reading) estimates.push(reading);

  // 练习：答对题数 → 百分制。ExerciseResult 无 difficulty 字段，级别仅取自
  // record.difficulty_level（旧记录为 null 时无回退来源，丢弃样本）。
  const exerciseSamples = collectScored(
    inputs.exercise.map(({ record, result }) => {
      const total = result.exercises.length;
      return {
        record,
        level: resolveLevel(record),
        score: total > 0 ? (result.score / total) * 100 : null,
      };
    }),
  );
  const exercise = estimateFromScored("exercise", exerciseSamples);
  if (exercise) estimates.push(exercise);

  // 听力：score 本身 0-100
  const listeningSamples = collectScored(
    inputs.listening.map(({ record, result }) => ({
      record,
      level: resolveLevel(record, result.difficulty),
      score: result.score,
    })),
  );
  const listening = estimateFromScored("listening", listeningSamples);
  if (listening) estimates.push(listening);

  // 口语：averageScore 本身 0-100
  const speakingSamples = collectScored(
    inputs.speaking.map(({ record, result }) => ({
      record,
      level: resolveLevel(record, result.difficulty),
      score: result.averageScore,
    })),
  );
  const speaking = estimateFromScored("speaking", speakingSamples);
  if (speaking) estimates.push(speaking);

  return { estimates, suggestions: buildSuggestions(currentLevel, estimates) };
}

/**
 * 从原始记录 + result 字符串计算各技能估计与升级建议。
 *
 * 负责把 records 按类型分组并解析对应 result（reading 只取元数据、不解析
 * 重型 Markdown result），再委托 buildSkillEstimates。未命中 resultById 的
 * 记录（超出 resultLimit 的较旧记录）按缺失跳过。
 *
 * @param records - 轻量历史记录（类型覆盖六类）
 * @param resultById - 记录 id → result 原始字符串
 * @param currentLevel - 当前全局级别
 */
export function collectSkillEstimates(
  records: HistoryRecord[],
  resultById: Map<number, string>,
  currentLevel: LevelCode,
): { estimates: SkillEstimate[]; suggestions: LevelUpSuggestion[] } {
  const correct: ParsedPair<CorrectionResult>[] = [];
  const exercise: ParsedPair<ExerciseResult>[] = [];
  const listening: ParsedPair<ListeningResult>[] = [];
  const speaking: ParsedPair<SpeakingResult>[] = [];
  const reading: HistoryRecord[] = [];

  for (const r of records) {
    // 阅读只取 difficulty_level 元数据，重型 Markdown result 既不拉取也不解析
    if (r.type === "reading") {
      reading.push(r);
      continue;
    }
    const raw = resultById.get(r.id);
    if (raw === undefined) continue;
    if (r.type === "correct" || r.type === "writing") {
      const result = extractJsonSafe(raw, CorrectionResultSchema);
      if (result !== null) correct.push({ record: r, result });
    } else if (r.type === "exercise") {
      const result = extractJsonSafe(raw, ExerciseResultSchema);
      if (result !== null) exercise.push({ record: r, result });
    } else if (r.type === "listening") {
      const result = extractJsonSafe(raw, ListeningResultSchema);
      if (result !== null) listening.push({ record: r, result });
    } else if (r.type === "speaking") {
      const result = extractJsonSafe(raw, SpeakingResultSchema);
      if (result !== null) speaking.push({ record: r, result });
    }
  }

  return buildSkillEstimates({ correct, exercise, listening, speaking, reading }, currentLevel);
}

/** 独立加载参数：六类元数据一次取回，仅五类拉取重型 result（reading 只取元数据）。
 *  窗口常量与 Analytics 共用（lib/level-estimation.ts 单一来源，避免口径漂移）。 */
const RECORD_TYPES = ["correct", "writing", "exercise", "listening", "speaking", "reading"];
const RESULT_TYPES = ["correct", "writing", "exercise", "listening", "speaking"];

/**
 * 被动级别估计 hook（LevelCard 用）—— 独立加载历史并归一化。
 *
 * 挂载时经 getHistoryWithResults 一次取回六类轻量记录 + 五类 result，
 * 估计随 records / 当前级别变化重算；refresh() 重新拉取（应用建议后调用以
 * 刷新样本基数）。加载失败时静默降级为空估计（卡片显示引导空态），不抛错。
 *
 * @returns 各技能估计、升级建议、加载态与刷新函数
 */
export function useLevelEstimation(): {
  estimates: SkillEstimate[];
  suggestions: LevelUpSuggestion[];
  loading: boolean;
  refresh: () => void;
} {
  const { level } = useProficiencyLevel();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [resultById, setResultById] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // cancelled 守卫：refresh 连点 / 卸载时丢弃过期响应，慢的旧加载不覆盖新状态
    let cancelled = false;
    void reloadToken; // 重触发令牌：值本身不参与数据逻辑
    getHistoryWithResults(
      RECORD_TYPES,
      LEVEL_ESTIMATE_RECORD_LIMIT,
      RESULT_TYPES,
      LEVEL_ESTIMATE_RESULT_LIMIT,
    )
      .then(({ records: recs, resultById: byId }) => {
        if (cancelled) return;
        setRecords(recs);
        setResultById(byId);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("useLevelEstimation: getHistoryWithResults failed", err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const { estimates, suggestions } = useMemo(
    () => collectSkillEstimates(records, resultById, level),
    [records, resultById, level],
  );

  return {
    estimates,
    suggestions,
    loading,
    refresh: () => setReloadToken((t) => t + 1),
  };
}
