/**
 * Speaking analytics sub-hook.
 *
 * Derives speaking score trend data from speaking records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import { extractJson } from "@/lib/parse-utils";
import type { HistoryRecord, SpeakingResult } from "@/types";

/** Parsed speaking record. */
export interface ParsedSpeaking {
  record: HistoryRecord;
  result: SpeakingResult;
}

/** Return type for useSpeakingAnalytics. */
export interface SpeakingAnalytics {
  parsedSpeaking: ParsedSpeaking[];
  speakingTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes speaking practice records.
 *
 * @param speakingRecords - History records of type "speaking".
 * @returns Derived speaking analytics data.
 */
export function useSpeakingAnalytics(speakingRecords: HistoryRecord[]): SpeakingAnalytics {
  const parsedSpeaking: ParsedSpeaking[] = useMemo(() => {
    return speakingRecords
      .map((r) => ({
        record: r,
        result: extractJson<SpeakingResult>(r.result),
      }))
      .filter(
        (x): x is ParsedSpeaking =>
          x.result !== null &&
          typeof x.result.averageScore === "number" &&
          Array.isArray(x.result.sentences) &&
          x.result.sentences.length > 0,
      );
  }, [speakingRecords]);

  const speakingTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedSpeaking].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );
    return sorted.map((p) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
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
