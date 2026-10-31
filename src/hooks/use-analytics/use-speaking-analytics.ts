/**
 * Speaking analytics sub-hook.
 *
 * Derives speaking score trend data from speaking records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import type { ParsedSpeaking } from "@/lib/level-estimation-samples";
import { formatDifficultyLabel } from "@/lib/levels";
import { createRecordTimeIndex, type RecordTimeIndex } from "./record-time-index";

/** Return type for useSpeakingAnalytics. */
interface SpeakingAnalytics {
  parsedSpeaking: ParsedSpeaking[];
  speakingTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes speaking practice records.
 *
 * 解析已在编排层（useAnalytics）基于全部记录一次性完成；本 hook 直接消费
 * 已解析的口语记录数组，不再自行 JSON.parse。记录时间戳经 RecordTimeIndex
 * 只解析一次（H-02）；未传索引时（单元测试）本地建一份。
 *
 * @param parsedSpeaking - 已解析的口语记录（无效 result 已在上游过滤）。
 * @param timeIndex - 可选记录时间索引（编排层预计算，切换时间范围时复用）。
 * @returns Derived speaking analytics data.
 */
export function useSpeakingAnalytics(
  parsedSpeaking: ParsedSpeaking[],
  timeIndex?: RecordTimeIndex,
): SpeakingAnalytics {
  const times = useMemo(
    () => timeIndex ?? createRecordTimeIndex(parsedSpeaking.map((p) => p.record)),
    [timeIndex, parsedSpeaking],
  );

  const speakingTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedSpeaking].sort(
      (a, b) => times.timeOf(a.record) - times.timeOf(b.record),
    );
    return sorted.map((p) => ({
      date: times.chartDateOf(p.record),
      scorePercent: Math.round(p.result.averageScore),
      label: `${formatDifficultyLabel(p.result.difficulty)} - ${p.result.topic} (${p.result.averageScore}分)`,
    }));
  }, [parsedSpeaking, times]);

  return {
    parsedSpeaking,
    speakingTrendData,
  };
}
