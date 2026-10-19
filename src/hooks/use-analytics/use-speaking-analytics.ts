/**
 * Speaking analytics sub-hook.
 *
 * Derives speaking score trend data from speaking records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import { formatDifficultyLabel } from "@/lib/practice-options";
import type { HistoryRecord, SpeakingResult } from "@/types";

/** Parsed speaking record. */
export interface ParsedSpeaking {
  record: HistoryRecord;
  result: SpeakingResult;
}

/** Return type for useSpeakingAnalytics. */
interface SpeakingAnalytics {
  parsedSpeaking: ParsedSpeaking[];
  speakingTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes speaking practice records.
 *
 * 解析已在编排层（useAnalytics）基于全部记录一次性完成；本 hook 直接消费
 * 已解析的口语记录数组，不再自行 JSON.parse。
 *
 * @param parsedSpeaking - 已解析的口语记录（无效 result 已在上游过滤）。
 * @returns Derived speaking analytics data.
 */
export function useSpeakingAnalytics(parsedSpeaking: ParsedSpeaking[]): SpeakingAnalytics {
  const speakingTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedSpeaking].sort(
      (a, b) =>
        parseDbTimestamp(a.record.created_at).getTime() -
        parseDbTimestamp(b.record.created_at).getTime(),
    );
    return sorted.map((p) => ({
      date: parseDbTimestamp(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent: Math.round(p.result.averageScore),
      label: `${formatDifficultyLabel(p.result.difficulty)} - ${p.result.topic} (${p.result.averageScore}分)`,
    }));
  }, [parsedSpeaking]);

  return {
    parsedSpeaking,
    speakingTrendData,
  };
}
