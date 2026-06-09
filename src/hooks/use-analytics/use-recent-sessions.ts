/**
 * Recent sessions sub-hook.
 *
 * Derives the most recent 15 session summaries across all
 * learning activity types (writing, exercise, listening, reading).
 */
import { useMemo } from "react";
import type { SessionDetail } from "@/lib/analytics";
import type { CorrectionResult, ExerciseResult, HistoryRecord, ListeningResult } from "@/types";
import type { ParsedExercise } from "./use-exercise-analytics";
import type { ParsedListening } from "./use-listening-analytics";
import type { ParsedCorrection } from "./use-writing-analytics";

/** Return type for useRecentSessions. */
export interface RecentSessionsData {
  recentSessions: SessionDetail[];
}

/**
 * Computes recent session summaries across all types.
 *
 * @param allRecords      - All history records, sorted newest-first is fine.
 * @param parsed          - Parsed writing corrections.
 * @param parsedExercises - Parsed exercise results.
 * @param parsedListening - Parsed listening results.
 * @returns The 15 most recent sessions with type-specific detail.
 */
export function useRecentSessions(
  allRecords: HistoryRecord[],
  parsed: ParsedCorrection[],
  parsedExercises: ParsedExercise[],
  parsedListening: ParsedListening[],
): RecentSessionsData {
  const recentSessions: SessionDetail[] = useMemo(() => {
    // Build lookup maps from pre-parsed data for O(1) access
    const parsedByCorrectId = new Map<number, CorrectionResult>(
      parsed.map((p) => [p.record.id, p.result]),
    );
    const parsedByExerciseId = new Map<number, ExerciseResult>(
      parsedExercises.map((p) => [p.record.id, p.result]),
    );
    const parsedByListeningId = new Map<number, ListeningResult>(
      parsedListening.map((p) => [p.record.id, p.result]),
    );

    const allSorted = [...allRecords].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return allSorted.slice(0, 15).map((r) => {
      const base: SessionDetail = {
        id: r.id,
        date: new Date(r.created_at).toLocaleDateString("zh-CN"),
        textPreview: r.input_text.slice(0, 60) + (r.input_text.length > 60 ? "..." : ""),
        type: r.type,
      };
      if (r.type === "correct") {
        const result = parsedByCorrectId.get(r.id);
        if (result) {
          const catMap = new Map<string, number>();
          result.corrections.forEach((c) => {
            catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
          });
          base.topCategory =
            Array.from(catMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
          base.total = result.corrections.length;
        }
      } else if (r.type === "exercise") {
        const result = parsedByExerciseId.get(r.id);
        if (result) {
          base.score = result.score;
          base.total = result.exercises.length;
        }
      } else if (r.type === "listening") {
        const result = parsedByListeningId.get(r.id);
        if (result) {
          base.score = result.score;
          base.total = result.sentences.length;
        }
      }
      return base;
    });
  }, [allRecords, parsed, parsedExercises, parsedListening]);

  return { recentSessions };
}
