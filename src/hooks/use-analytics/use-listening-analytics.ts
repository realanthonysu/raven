/**
 * Listening analytics sub-hook.
 *
 * Derives listening score trend data from listening records.
 */
import { useMemo } from "react";
import { isListeningResult, type ScoreTrendPoint } from "@/lib/analytics";
import { extractJson } from "@/lib/parse-utils";
import type { HistoryRecord, ListeningResult } from "@/types";

/** Parsed listening record. */
export interface ParsedListening {
  record: HistoryRecord;
  result: ListeningResult;
}

/** Return type for useListeningAnalytics. */
export interface ListeningAnalytics {
  parsedListening: ParsedListening[];
  listeningTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes listening practice records.
 *
 * @param listeningRecords - History records of type "listening".
 * @param results - Pre-fetched result JSON strings（与 listeningRecords 一一对应）。
 * @returns Derived listening analytics data.
 */
export function useListeningAnalytics(
  listeningRecords: HistoryRecord[],
  results?: string[],
): ListeningAnalytics {
  // === Pre-parse listening results ===
  const parsedListening: ParsedListening[] = useMemo(() => {
    return listeningRecords
      .map((r, i) => ({
        record: r,
        result: extractJson<ListeningResult>(
          results ? (results[i] ?? "") : r.result,
          isListeningResult,
        ),
      }))
      .filter((x): x is ParsedListening => x.result !== null);
  }, [listeningRecords, results]);

  // === Listening score trend ===
  const listeningTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedListening].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );
    return sorted.map((p) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent:
        p.result.sentences.length > 0
          ? Math.round((p.result.score / p.result.sentences.length) * 100)
          : 0,
      label: `${p.result.difficulty} - ${p.result.topic} (${p.result.score}/${p.result.sentences.length})`,
    }));
  }, [parsedListening]);

  return {
    parsedListening,
    listeningTrendData,
  };
}
