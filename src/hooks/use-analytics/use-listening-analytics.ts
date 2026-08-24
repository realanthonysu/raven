/**
 * Listening analytics sub-hook.
 *
 * Derives listening score trend data from listening records.
 */
import { useMemo } from "react";
import type { ScoreTrendPoint } from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import { extractJsonSafe } from "@/lib/parse-utils";
import { ListeningResultSchema } from "@/lib/schemas";
import type { HistoryRecord, ListeningResult } from "@/types";

/** Parsed listening record. */
export interface ParsedListening {
  record: HistoryRecord;
  result: ListeningResult;
}

/** Return type for useListeningAnalytics. */
interface ListeningAnalytics {
  parsedListening: ParsedListening[];
  listeningTrendData: ScoreTrendPoint[];
}

/**
 * Analyzes listening practice records.
 *
 * @param listeningRecords - History records of type "listening".
 * @param getResult - 按 id 查找预获取 result 的函数（编排层从
 *   getHistoryWithResults 的 resultById 注入）。
 *   记录不在 Map 中时返回 undefined，回退到 record.result。
 * @returns Derived listening analytics data.
 */
export function useListeningAnalytics(
  listeningRecords: HistoryRecord[],
  getResult?: (id: number) => string | undefined,
): ListeningAnalytics {
  // === Pre-parse listening results ===
  const parsedListening: ParsedListening[] = useMemo(() => {
    return listeningRecords
      .map((r) => ({
        record: r,
        result: extractJsonSafe(getResult?.(r.id) ?? r.result, ListeningResultSchema),
      }))
      .filter((x): x is ParsedListening => x.result !== null);
  }, [listeningRecords, getResult]);

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
