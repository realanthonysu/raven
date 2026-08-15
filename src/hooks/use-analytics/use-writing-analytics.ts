/**
 * Writing analytics sub-hook.
 *
 * Derives error statistics, category distribution, trend data,
 * improvement metrics, and weak category recommendations from
 * writing correction records.
 */
import { useMemo } from "react";
import type { CategoryStat, TrendPoint } from "@/lib/analytics";
import { parseResult } from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import type { CorrectionResult, HistoryRecord } from "@/types";

/** Parsed correction record used by writing analytics. */
export interface ParsedCorrection {
  record: HistoryRecord;
  result: CorrectionResult;
}

/** Return type for useWritingAnalytics. */
export interface WritingAnalytics {
  parsed: ParsedCorrection[];
  totalArticles: number;
  totalErrors: number;
  avgErrors: string;
  uniqueCategories: number;
  categoryData: CategoryStat[];
  trendData: TrendPoint[];
  improvement: { diff: number; pct: string; avgFirst: string; avgSecond: string } | null;
  weakCategories: { name: string; count: number }[];
}

/**
 * Analyzes writing correction records.
 *
 * @param correctRecords - History records of type "correct"（含 legacy "writing"）.
 * @param results - Pre-fetched result strings keyed by record id（from getHistoryResultsByType）。
 *   按 id 精确配对；记录不在 Map 中（如查询间隙新增）时回退到 record.result。
 * @returns Derived writing analytics data.
 */
export function useWritingAnalytics(
  correctRecords: HistoryRecord[],
  results?: Map<number, string>,
): WritingAnalytics {
  // === Parse correction results ===
  const parsed: ParsedCorrection[] = useMemo(() => {
    return correctRecords
      .map((r) => ({
        record: r,
        result: parseResult(results?.get(r.id) ?? r.result),
      }))
      .filter((x): x is ParsedCorrection => x.result !== null);
  }, [correctRecords, results]);

  // === Basic error stats ===
  const totalArticles = parsed.length;
  const totalErrors = parsed.reduce((sum, p) => sum + p.result.corrections.length, 0);
  const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";

  // === Category distribution ===
  const allCategories = useMemo(() => {
    const map = new Map<string, number>();
    parsed.forEach((p) => {
      p.result.corrections.forEach((c) => {
        map.set(c.category, (map.get(c.category) ?? 0) + 1);
      });
    });
    return map;
  }, [parsed]);

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

  // === Weak category recommendations ===
  // 返回全部候选（按出现次数降序），由编排层结合练习掌握度降权后再截取 top N
  const weakCategories = useMemo(() => {
    const recent = [...parsed]
      .sort(
        (a, b) =>
          parseDbTimestamp(b.record.created_at).getTime() -
          parseDbTimestamp(a.record.created_at).getTime(),
      )
      .slice(0, 10);
    if (recent.length === 0) return [];
    const catMap = new Map<string, number>();
    recent.forEach((p) => {
      p.result.corrections.forEach((c) => {
        catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
      });
    });
    return Array.from(catMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [parsed]);

  return {
    parsed,
    totalArticles,
    totalErrors,
    avgErrors,
    uniqueCategories,
    categoryData,
    trendData,
    improvement,
    weakCategories,
  };
}
