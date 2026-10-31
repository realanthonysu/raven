/**
 * Listening analytics sub-hook.
 *
 * Derives listening score trend data from listening records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import type { ParsedListening } from "@/lib/level-estimation-samples";
import { formatDifficultyLabel } from "@/lib/levels";
import { listeningScorePercent } from "@/lib/score-percent";
import { createRecordTimeIndex, type RecordTimeIndex } from "./record-time-index";

/** Return type for useListeningAnalytics. */
interface ListeningAnalytics {
  parsedListening: ParsedListening[];
  listeningTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes listening practice records.
 *
 * 解析已在编排层（useAnalytics）基于全部记录一次性完成；本 hook 直接消费
 * 已解析的听力记录数组，不再自行 JSON.parse。记录时间戳经 RecordTimeIndex
 * 只解析一次（H-02）；未传索引时（单元测试）本地建一份。
 *
 * @param parsedListening - 已解析的听力记录（无效 result 已在上游过滤）。
 * @param timeIndex - 可选记录时间索引（编排层预计算，切换时间范围时复用）。
 * @returns Derived listening analytics data.
 */
export function useListeningAnalytics(
  parsedListening: ParsedListening[],
  timeIndex?: RecordTimeIndex,
): ListeningAnalytics {
  const times = useMemo(
    () => timeIndex ?? createRecordTimeIndex(parsedListening.map((p) => p.record)),
    [timeIndex, parsedListening],
  );

  // === Listening score trend ===
  const listeningTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedListening].sort(
      (a, b) => times.timeOf(a.record) - times.timeOf(b.record),
    );
    return sorted.map((p) => ({
      date: times.chartDateOf(p.record),
      scorePercent: Math.round(
        listeningScorePercent(p.result.score, p.result.sentences.length) ?? 0,
      ),
      label: `${formatDifficultyLabel(p.result.difficulty)} - ${p.result.topic} (${p.result.score}/${p.result.sentences.length})`,
    }));
  }, [parsedListening, times]);

  return {
    parsedListening,
    listeningTrendData,
  };
}
