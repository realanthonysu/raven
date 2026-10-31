/**
 * Writing analytics sub-hook.
 *
 * Derives error statistics, category distribution, trend data, and
 * improvement metrics from writing correction records.
 * （弱项候选管线已上移：编排层经 lib/exercise-stats 的 rankWeakCategories
 * 与 Dashboard 共享同一实现，本 hook 不再输出 weakCategories。）
 */
import { useMemo } from "react";
import type { CategoryStat, TrendPoint } from "@/lib/analytics";
import { countCorrectionCategories } from "@/lib/exercise-stats";
import type { ParsedCorrection } from "@/lib/level-estimation-samples";
import { createRecordTimeIndex, type RecordTimeIndex } from "./record-time-index";

/** Return type for useWritingAnalytics. */
interface WritingAnalytics {
  parsed: ParsedCorrection[];
  totalArticles: number;
  totalErrors: number;
  avgErrors: string;
  uniqueCategories: number;
  categoryData: CategoryStat[];
  trendData: TrendPoint[];
  improvement: { diff: number; pct: string; avgFirst: string; avgSecond: string } | null;
}

/**
 * Analyzes writing correction records.
 *
 * 解析已在编排层（useAnalytics）基于全部记录一次性完成；本 hook 直接消费
 * 已解析的写作批改数组，不再自行 JSON.parse。记录时间戳经编排层下发的
 * RecordTimeIndex 只解析一次（H-02）；未传索引时（单元测试）本地建一份。
 *
 * @param parsed - 已解析的写作批改记录（correct/writing，无效 result 已在上游过滤）。
 * @param timeIndex - 可选记录时间索引（编排层预计算，切换时间范围时复用）。
 * @returns Derived writing analytics data.
 */
export function useWritingAnalytics(
  parsed: ParsedCorrection[],
  timeIndex?: RecordTimeIndex,
): WritingAnalytics {
  const times = useMemo(
    () => timeIndex ?? createRecordTimeIndex(parsed.map((p) => p.record)),
    [timeIndex, parsed],
  );

  // === Basic error stats（H-04：聚合并入 memo，随 parsed 变化只算一次） ===
  const stats = useMemo(() => {
    const totalArticles = parsed.length;
    let totalErrors = 0;
    for (const p of parsed) totalErrors += p.result.corrections.length;
    const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";
    return { totalArticles, totalErrors, avgErrors };
  }, [parsed]);

  // === Category distribution ===
  const allCategories = useMemo(
    () => countCorrectionCategories(parsed.flatMap((p) => p.result.corrections)),
    [parsed],
  );

  const uniqueCategories = allCategories.size;

  const categoryData: CategoryStat[] = useMemo(() => {
    return Array.from(allCategories.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allCategories]);

  // === Error trend ===
  const trendData: TrendPoint[] = useMemo(() => {
    const sorted = [...parsed].sort((a, b) => times.timeOf(a.record) - times.timeOf(b.record));
    return sorted.map((p, i) => ({
      date: times.chartDateOf(p.record),
      errors: p.result.corrections.length,
      index: i + 1,
    }));
  }, [parsed, times]);

  // === Improvement (compare first half vs second half) ===
  const improvement = useMemo(() => {
    if (trendData.length < 2) return null;
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid);
    const secondHalf = trendData.slice(mid);
    const avgFirst = firstHalf.reduce((s, d) => s + d.errors, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d.errors, 0) / secondHalf.length;
    const diff = avgFirst - avgSecond;
    const pct = avgFirst > 0 ? ((diff / avgFirst) * 100).toFixed(0) : "0";
    return { diff, pct, avgFirst: avgFirst.toFixed(1), avgSecond: avgSecond.toFixed(1) };
  }, [trendData]);

  return {
    parsed,
    totalArticles: stats.totalArticles,
    totalErrors: stats.totalErrors,
    avgErrors: stats.avgErrors,
    uniqueCategories,
    categoryData,
    trendData,
    improvement,
  };
}
