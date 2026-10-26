/**
 * 被动级别估计 hook（LevelCard 用）—— 独立加载历史并归一化（Phase 4 被动定级）。
 *
 * 两层结构：
 * - 窗口加载（含 stale 守卫、fail-soft 错误、reload 与 result 窗口截断旗标）
 *   委托给共享的 useHistoryWindow（与 use-analytics 编排层同一 owner，窗口
 *   协议不再两处手写）；
 * - 纯归一化核心在 lib/level-estimation-samples.ts（不依赖 React）：
 *   collectSkillEstimates（原始记录 → 估计的便捷入口）内部经
 *   groupAndParseResults 按类型分 schema 解析后喂给估计引擎。
 *   Analytics 编排层与 LevelCard 侧共用同一模块，口径不再两处漂移。
 *
 * 挂载时经 useHistoryWindow 一次取回六类轻量记录 + 五类 result，估计随
 * records / 当前级别变化重算；refresh() 重新拉取（应用建议后调用以刷新样本
 * 基数）。加载失败时不抛错（fail-soft）：错误信息经 error 字段暴露，由调用方
 * 渲染错误态与重试入口，而不是伪装成"练习数据不足"的空态。
 * resultsWindowLimited 透出重型 result 窗口是否被 HISTORY_RESULT_LIMIT 截断
 * （与 useAnalytics 同一 hook 同一口径），供 UI 披露估计的数据覆盖范围。
 */

import { useMemo } from "react";
import { useHistoryWindow } from "@/hooks/use-history-window";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import type { LevelUpSuggestion, SkillEstimate } from "@/lib/level-estimation";
import { collectSkillEstimates } from "@/lib/level-estimation-samples";

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
  /** result 窗口是否被 HISTORY_RESULT_LIMIT 截断（取满上限即视为可能截断） */
  resultsWindowLimited: boolean;
  refresh: () => void;
} {
  const { level } = useProficiencyLevel();
  const { records, resultById, loading, error, resultsWindowLimited, reload } = useHistoryWindow();

  const { estimates, suggestions } = useMemo(
    () => collectSkillEstimates(records, resultById, level),
    [records, resultById, level],
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
