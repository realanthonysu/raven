/**
 * 被动级别估计 hook（LevelCard 用）—— 独立加载历史并归一化（Phase 4 被动定级）。
 *
 * 两层结构：
 * - 纯归一化核心在 lib/level-estimation-samples.ts（不依赖 React）：
 *   buildSkillEstimates（样本归一化 + 估计引擎 + 建议）、
 *   groupAndParseResults（按类型分 schema 的解析派发）、
 *   collectSkillEstimates（原始记录 → 估计的便捷入口）与窗口类型常量
 *   LEVEL_ESTIMATE_RECORD_TYPES / LEVEL_ESTIMATE_RESULT_TYPES。
 *   Analytics 编排层与 LevelCard 侧共用同一模块，口径不再两处漂移。
 * - 本文件只保留 useLevelEstimation 的 React 生命周期：挂载加载、
 *   stale 守卫、fail-soft 错误暴露、result 窗口截断标志与刷新。
 *
 * 挂载时经 getHistoryWithResults 一次取回六类轻量记录 + 五类 result，
 * 估计随 records / 当前级别变化重算；refresh() 重新拉取（应用建议后调用以
 * 刷新样本基数）。加载失败时不抛错（fail-soft）：错误信息经 error 字段暴露，
 * 由调用方渲染错误态与重试入口，而不是伪装成"练习数据不足"的空态。
 * resultsWindowLimited 透出重型 result 窗口是否被 LEVEL_ESTIMATE_RESULT_LIMIT
 * 截断（与 useAnalytics 同口径），供 UI 披露估计的数据覆盖范围。
 */

import { useEffect, useMemo, useState } from "react";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { getHistoryWithResults } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  LEVEL_ESTIMATE_RECORD_LIMIT,
  LEVEL_ESTIMATE_RESULT_LIMIT,
  type LevelUpSuggestion,
  type SkillEstimate,
} from "@/lib/level-estimation";
import {
  collectSkillEstimates,
  LEVEL_ESTIMATE_RECORD_TYPES,
  LEVEL_ESTIMATE_RESULT_TYPES,
} from "@/lib/level-estimation-samples";
import type { HistoryRecord } from "@/types";

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
  /** result 窗口是否被 LEVEL_ESTIMATE_RESULT_LIMIT 截断（取满上限即视为可能截断） */
  resultsWindowLimited: boolean;
  refresh: () => void;
} {
  const { level } = useProficiencyLevel();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [resultById, setResultById] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // stale 守卫：refresh 连点 / 卸载时丢弃过期响应，慢的旧加载不覆盖新状态
  const { begin, isStale } = useStaleGuard();

  useEffect(() => {
    const seq = begin();
    void reloadToken; // 重触发令牌：值本身不参与数据逻辑
    setError(null);
    getHistoryWithResults(
      LEVEL_ESTIMATE_RECORD_TYPES,
      LEVEL_ESTIMATE_RECORD_LIMIT,
      LEVEL_ESTIMATE_RESULT_TYPES,
      LEVEL_ESTIMATE_RESULT_LIMIT,
    )
      .then(({ records: recs, resultById: byId }) => {
        if (isStale(seq)) return;
        setRecords(recs);
        setResultById(byId);
        setLoading(false);
      })
      .catch((err) => {
        if (isStale(seq)) return;
        console.warn("useLevelEstimation: getHistoryWithResults failed", err);
        // 失败不抛错（页面不白屏），但错误必须可见：调用方渲染错误横幅 + 重试，
        // 不得让加载失败伪装成"数据不足"
        setError(getErrorMessage(err, "级别估计加载失败"));
        setLoading(false);
      });
    return () => {
      // useStaleGuard 无 cleanup：重触发/卸载时主动 begin() 使在途响应过期，
      // 保留原 cancelled 守卫的卸载丢弃语义
      begin();
    };
  }, [reloadToken, begin, isStale]);

  const { estimates, suggestions } = useMemo(
    () => collectSkillEstimates(records, resultById, level),
    [records, resultById, level],
  );

  // result 窗口截断标志：取到的 result 数达到上限即视为可能截断（恰为上限时
  // 无法区分是否还有更多）；result 数为 0（含加载失败降级）时自然为 false。
  // 与 useAnalytics（use-analytics/index.ts）同一口径，两处披露文案不得漂移。
  const resultsWindowLimited = resultById.size >= LEVEL_ESTIMATE_RESULT_LIMIT;

  return {
    estimates,
    suggestions,
    loading,
    error,
    resultsWindowLimited,
    refresh: () => setReloadToken((t) => t + 1),
  };
}
