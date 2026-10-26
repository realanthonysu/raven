/**
 * Listening analytics sub-hook.
 *
 * Derives listening score trend data from listening records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import type { ParsedListening } from "@/lib/level-estimation-samples";
import { formatDifficultyLabel } from "@/lib/levels";
import { listeningScorePercent } from "@/lib/score-percent";

/** Return type for useListeningAnalytics. */
interface ListeningAnalytics {
  parsedListening: ParsedListening[];
  listeningTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes listening practice records.
 *
 * 解析已在编排层（useAnalytics）基于全部记录一次性完成；本 hook 直接消费
 * 已解析的听力记录数组，不再自行 JSON.parse。
 *
 * @param parsedListening - 已解析的听力记录（无效 result 已在上游过滤）。
 * @returns Derived listening analytics data.
 */
export function useListeningAnalytics(parsedListening: ParsedListening[]): ListeningAnalytics {
  // === Listening score trend ===
  const listeningTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedListening].sort(
      (a, b) =>
        parseDbTimestamp(a.record.created_at).getTime() -
        parseDbTimestamp(b.record.created_at).getTime(),
    );
    return sorted.map((p) => ({
      date: parseDbTimestamp(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent: Math.round(
        listeningScorePercent(p.result.score, p.result.sentences.length) ?? 0,
      ),
      label: `${formatDifficultyLabel(p.result.difficulty)} - ${p.result.topic} (${p.result.score}/${p.result.sentences.length})`,
    }));
  }, [parsedListening]);

  return {
    parsedListening,
    listeningTrendData,
  };
}
