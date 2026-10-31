/**
 * Recent sessions sub-hook.
 *
 * Derives the most recent 15 session summaries across all
 * learning activity types (writing, exercise, listening, reading, speaking).
 */
import { useMemo } from "react";
import type { SessionDetail } from "@/lib/analytics";
import { countCorrectionCategories } from "@/lib/exercise-stats";
import type {
  ParsedCorrection,
  ParsedExercise,
  ParsedListening,
  ParsedSpeaking,
} from "@/lib/level-estimation-samples";
import type {
  CorrectionResult,
  ExerciseResult,
  HistoryRecord,
  ListeningResult,
  SpeakingResult,
} from "@/types";
import { createRecordTimeIndex, type RecordTimeIndex } from "./record-time-index";

/** Return type for useRecentSessions. */
interface RecentSessionsData {
  recentSessions: SessionDetail[];
}

/**
 * Computes recent session summaries across all types.
 *
 * @param allRecords      - All history records, sorted newest-first is fine.
 * @param parsed          - Parsed writing corrections.
 * @param parsedExercises - Parsed exercise results.
 * @param parsedListening - Parsed listening results.
 * @param parsedSpeaking  - Parsed speaking results.
 * @param timeIndex       - 可选记录时间索引（编排层预计算，记录排序/日期不重复解析）。
 * @returns The 15 most recent sessions with type-specific detail.
 */
export function useRecentSessions(
  allRecords: HistoryRecord[],
  parsed: ParsedCorrection[],
  parsedExercises: ParsedExercise[],
  parsedListening: ParsedListening[],
  parsedSpeaking: ParsedSpeaking[],
  timeIndex?: RecordTimeIndex,
): RecentSessionsData {
  const times = useMemo(
    () => timeIndex ?? createRecordTimeIndex(allRecords),
    [timeIndex, allRecords],
  );

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
    const parsedBySpeakingId = new Map<number, SpeakingResult>(
      parsedSpeaking.map((p) => [p.record.id, p.result]),
    );

    const allSorted = [...allRecords].sort((a, b) => times.timeOf(b) - times.timeOf(a));
    return allSorted.slice(0, 15).map((r) => {
      const base: SessionDetail = {
        id: r.id,
        date: times.fullDateOf(r),
        textPreview: r.input_text.slice(0, 60) + (r.input_text.length > 60 ? "..." : ""),
        type: r.type,
      };
      if (r.type === "correct" || r.type === "writing") {
        const result = parsedByCorrectId.get(r.id);
        if (result) {
          const catMap = countCorrectionCategories(result.corrections);
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
      } else if (r.type === "speaking") {
        const result = parsedBySpeakingId.get(r.id);
        if (result) {
          base.score = result.averageScore;
          base.total = result.sentences.length;
        }
      }
      return base;
    });
  }, [allRecords, parsed, parsedExercises, parsedListening, parsedSpeaking, times]);

  return { recentSessions };
}
