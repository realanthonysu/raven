/**
 * 被动级别估计 hook（LevelCard 用）—— 独立加载历史并归一化（Phase 4 被动定级）。
 *
 * 两层结构：
 * - 窗口加载（含 stale 守卫、fail-soft 错误、reload 与 result 窗口截断旗标）
 *   委托给共享的 useHistoryWindow（与 use-analytics 编排层同一 owner，窗口
 *   协议不再两处手写）。本 hook 使用比 Analytics 更小的专用窗口
 *   （LEVEL_ESTIMATION_RECORD_LIMIT / LEVEL_ESTIMATION_RESULT_LIMIT）：被动估计
 *   只需近期样本，避免打开设置页就拉取分析页级的大窗口；
 * - 纯归一化核心在 lib/level-estimation-samples.ts（不依赖 React）：
 *   groupAndParseResults 先把原始 result 解析一次并缓存，再由
 *   buildSkillEstimates 随当前级别重算——切换级别不会重复 JSON.parse + Zod。
 *
 * 挂载时经 useHistoryWindow 一次取回六类轻量记录 + 五类 result；refresh()
 * 重新拉取（应用建议后调用以刷新样本基数）。加载失败时不抛错（fail-soft）：
 * 错误信息经 error 字段暴露，由调用方渲染错误态与重试入口，而不是伪装成
 * "练习数据不足"的空态。resultsWindowLimited 透出本次 result 窗口是否被
 * LEVEL_ESTIMATION_RESULT_LIMIT 截断，供 UI 披露估计的数据覆盖范围。
 */

import { useMemo } from "react";
import { useHistoryWindow } from "@/hooks/use-history-window";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import type { LevelUpSuggestion, SkillEstimate } from "@/lib/level-estimation";
import { buildSkillEstimates, groupAndParseResults } from "@/lib/level-estimation-samples";

/** 被动估计的轻量元数据窗口：只取近期样本，低于 Analytics 的 HISTORY_RECORD_LIMIT(500)。 */
export const LEVEL_ESTIMATION_RECORD_LIMIT = 200;
/** 被动估计的重型 result 窗口：只解析最近一批，低于 Analytics 的 HISTORY_RESULT_LIMIT(150)。 */
export const LEVEL_ESTIMATION_RESULT_LIMIT = 80;

/** 窗口覆盖对象的稳定引用（useHistoryWindow 只需读取其中两个原始值）。 */
const LEVEL_ESTIMATION_WINDOW = {
  recordLimit: LEVEL_ESTIMATION_RECORD_LIMIT,
  resultLimit: LEVEL_ESTIMATION_RESULT_LIMIT,
} as const;

/**
 * 被动级别估计 hook（LevelCard 用）—— 独立加载历史并归一化。
 *
 * @returns 各技能估计、升级建议、加载态、错误信息、截断标志与刷新函数
 */
export function useLevelEstimation(): {
  estimates: SkillEstimate[];
  suggestions: LevelUpSuggestion[];
  loading: boolean;
  /** 加载失败的错误信息（null 表示无错误）；失败时调用方应渲染错误态而非空态 */
  error: string | null;
  /** result 窗口是否被 LEVEL_ESTIMATION_RESULT_LIMIT 截断（取满上限即视为可能截断） */
  resultsWindowLimited: boolean;
  refresh: () => void;
} {
  const { level } = useProficiencyLevel();
  const { records, resultById, loading, error, resultsWindowLimited, reload } =
    useHistoryWindow(LEVEL_ESTIMATION_WINDOW);

  // 解析与估级拆成两级 memo：records/resultById 不变时（例如用户只是在
  // LevelCard 里点选不同级别）不重新执行 JSON.parse + Zod，只重算估计/建议。
  const parsed = useMemo(() => groupAndParseResults(records, resultById), [records, resultById]);
  const { estimates, suggestions } = useMemo(
    () => buildSkillEstimates(parsed, level),
    [parsed, level],
  );

  return {
    estimates,
    suggestions,
    loading,
    error,
    resultsWindowLimited,
    refresh: reload,
  };
}
