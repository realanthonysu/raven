/**
 * Speaking analytics sub-hook.
 *
 * Derives speaking score trend data from speaking records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import { extractJsonSafe } from "@/lib/parse-utils";
import { SpeakingResultSchema } from "@/lib/schemas";
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
 * @param speakingRecords - History records of type "speaking".
 * @param getResult - 按 id 查找预获取 result 的函数（编排层从
 *   getHistoryWithResults 的 resultById 注入）。
 *   记录不在 Map 中时返回 undefined，回退到 record.result。
 * @returns Derived speaking analytics data.
 */
export function useSpeakingAnalytics(
  speakingRecords: HistoryRecord[],
  getResult?: (id: number) => string | undefined,
): SpeakingAnalytics {
  const parsedSpeaking: ParsedSpeaking[] = useMemo(() => {
    return speakingRecords
      .map((r) => ({
        record: r,
        result: extractJsonSafe(getResult?.(r.id) ?? r.result, SpeakingResultSchema),
      }))
      .filter((x): x is ParsedSpeaking => x.result !== null);
  }, [speakingRecords, getResult]);

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
      label: `${p.result.difficulty} - ${p.result.topic} (${p.result.averageScore}分)`,
    }));
  }, [parsedSpeaking]);

  return {
    parsedSpeaking,
    speakingTrendData,
  };
}
