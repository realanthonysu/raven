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
import { parseDbTimestamp } from "@/lib/db";
import { countCorrectionCategories } from "@/lib/exercise-stats";
import type { ParsedCorrection } from "@/lib/level-estimation-samples";

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
 * 已解析的写作批改数组，不再自行 JSON.parse。
 *
 * @param parsed - 已解析的写作批改记录（correct/writing，无效 result 已在上游过滤）。
 * @returns Derived writing analytics data.
 */
export function useWritingAnalytics(parsed: ParsedCorrection[]): WritingAnalytics {
  // === Basic error stats ===
  const totalArticles = parsed.length;
  const totalErrors = parsed.reduce((sum, p) => sum + p.result.corrections.length, 0);
  const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";

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
    const sorted = [...parsed].sort(
      (a, b) =>
        parseDbTimestamp(a.record.created_at).getTime() -
        parseDbTimestamp(b.record.created_at).getTime(),
    );
    return sorted.map((p, i) => ({
      date: parseDbTimestamp(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      errors: p.result.corrections.length,
      index: i + 1,
    }));
  }, [parsed]);

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
    totalArticles,
    totalErrors,
    avgErrors,
    uniqueCategories,
    categoryData,
    trendData,
    improvement,
  };
}
