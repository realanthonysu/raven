/**
 * Exercise analytics sub-hook.
 *
 * Derives exercise score trends, capability radar data, and
 * best/worst dimension from exercise records.
 *
 * Also takes parsed writing corrections so it can combine writing
 * error dimensions with exercise scores in the capability radar.
 */
import { useMemo } from "react";
import {
  type CapabilityPoint,
  DIMENSION_CONFIG,
  DIMENSION_MAP,
  isExerciseResult,
  type ScoreTrendPoint,
} from "@/lib/analytics";
import { extractJson } from "@/lib/parse-utils";
import type { ExerciseResult, HistoryRecord } from "@/types";
import type { ParsedListening } from "./use-listening-analytics";
import type { ParsedSpeaking } from "./use-speaking-analytics";
import type { ParsedCorrection } from "./use-writing-analytics";

/** Parsed exercise record. */
export interface ParsedExercise {
  record: HistoryRecord;
  result: ExerciseResult;
}

/** Return type for useExerciseAnalytics. */
export interface ExerciseAnalytics {
  parsedExercises: ParsedExercise[];
  exerciseTrendData: ScoreTrendPoint[];
  capabilityData: CapabilityPoint[];
  bestDimension: string;
  worstDimension: string;
}

/**
 * Analyzes exercise records and computes the capability radar.
 *
 * @param exerciseRecords - History records of type "exercise".
 * @param parsedWriting   - Parsed writing corrections (from useWritingAnalytics).
 * @param parsedListening - Parsed listening records (from useListeningAnalytics).
 * @param parsedSpeaking  - Parsed speaking records (from useSpeakingAnalytics).
 * @returns Derived exercise analytics data.
 */
export function useExerciseAnalytics(
  exerciseRecords: HistoryRecord[],
  parsedWriting: ParsedCorrection[],
  parsedListening: ParsedListening[],
  parsedSpeaking: ParsedSpeaking[],
): ExerciseAnalytics {
  // === Pre-parse exercise results (shared across trend + capability) ===
  const parsedExercises: ParsedExercise[] = useMemo(() => {
    return exerciseRecords
      .map((r) => ({
        record: r,
        result: extractJson<ExerciseResult>(r.result, isExerciseResult),
      }))
      .filter((x): x is ParsedExercise => x.result !== null);
  }, [exerciseRecords]);

  // === Exercise score trend ===
  const exerciseTrendData: ScoreTrendPoint[] = useMemo(() => {
    const sorted = [...parsedExercises].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );
    return sorted.map((p) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent:
        p.result.exercises.length > 0
          ? Math.round((p.result.score / p.result.exercises.length) * 100)
          : 0,
      label: `${p.result.category} (${p.result.score}/${p.result.exercises.length})`,
    }));
  }, [parsedExercises]);

  // === Capability radar (combines writing errors + exercise/listening/speaking scores) ===
  const capabilityData = useMemo<CapabilityPoint[]>(() => {
    const writingDims = ["语法", "词汇", "句式", "细节"];

    const dimensionErrorsPerArticle: Record<string, number[]> = {};
    for (const dim of writingDims) {
      dimensionErrorsPerArticle[dim] = [];
    }

    const sortedParsed = [...parsedWriting].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );

    for (const p of sortedParsed) {
      const dimCounts: Record<string, number> = {};
      for (const dim of writingDims) dimCounts[dim] = 0;
      for (const c of p.result.corrections) {
        const dim = DIMENSION_MAP[c.category];
        if (dim) dimCounts[dim] = (dimCounts[dim] ?? 0) + 1;
      }
      for (const dim of writingDims) {
        dimensionErrorsPerArticle[dim].push(dimCounts[dim]);
      }
    }

    const dimensionAvgErrors: Record<string, number> = {};
    let maxAvg = 0;
    for (const dim of writingDims) {
      const errors = dimensionErrorsPerArticle[dim];
      const avg = errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : 0;
      dimensionAvgErrors[dim] = avg;
      if (avg > maxAvg) maxAvg = avg;
    }

    const exerciseScoresByDim: Record<string, number[]> = {};
    for (const dim of writingDims) exerciseScoresByDim[dim] = [];
    for (const p of parsedExercises) {
      const dim = DIMENSION_MAP[p.result.category];
      if (!dim) continue;
      const pct =
        p.result.exercises.length > 0 ? (p.result.score / p.result.exercises.length) * 100 : 0;
      exerciseScoresByDim[dim].push(pct);
    }

    const listeningScores = parsedListening.map((p) =>
      p.result.sentences.length > 0
        ? Math.round((p.result.score / p.result.sentences.length) * 100)
        : 0,
    );
    const speakingScores = parsedSpeaking.map((p) => Math.round(p.result.averageScore));

    const scoreTrend = (scores: number[]): CapabilityPoint["trend"] => {
      if (scores.length < 2) return "none";
      const mid = Math.floor(scores.length / 2);
      const first = scores.slice(0, mid || 1);
      const second = scores.slice(mid || 1);
      const avgFirst = first.reduce((s, v) => s + v, 0) / first.length;
      const avgSecond = second.reduce((s, v) => s + v, 0) / second.length;
      if (avgSecond - avgFirst > 3) return "improving";
      if (avgFirst - avgSecond > 3) return "declining";
      return "stable";
    };

    return DIMENSION_CONFIG.map((dim) => {
      // 听力 / 口语：直接取自对应练习平均分
      if (dim.name === "听力") {
        const score =
          listeningScores.length > 0
            ? Math.round(listeningScores.reduce((s, v) => s + v, 0) / listeningScores.length)
            : 50;
        return {
          dimension: dim.name,
          score,
          trend: scoreTrend(listeningScores),
          color: dim.color,
        };
      }
      if (dim.name === "口语") {
        const score =
          speakingScores.length > 0
            ? Math.round(speakingScores.reduce((s, v) => s + v, 0) / speakingScores.length)
            : 50;
        return {
          dimension: dim.name,
          score,
          trend: scoreTrend(speakingScores),
          color: dim.color,
        };
      }

      // 语法 / 词汇 / 句式 / 细节：原写作+练习逻辑
      const errors = dimensionErrorsPerArticle[dim.name];
      const hasWritingData = errors.length > 0;
      let writingScore = 50;
      let trend: CapabilityPoint["trend"] = "none";

      if (hasWritingData) {
        const mid = Math.floor(errors.length / 2);
        const recentErrors = mid > 0 ? errors.slice(mid) : errors;
        const recentAvg = recentErrors.reduce((s, e) => s + e, 0) / recentErrors.length;
        writingScore =
          maxAvg > 0 ? Math.max(0, Math.min(100, 100 - (recentAvg / maxAvg) * 100)) : 100;
        if (errors.length >= 2) {
          const firstHalf = errors.slice(0, mid || 1);
          const secondHalf = errors.slice(mid || 1);
          const avgFirst = firstHalf.reduce((s, e) => s + e, 0) / firstHalf.length;
          const avgSecond = secondHalf.reduce((s, e) => s + e, 0) / secondHalf.length;
          if (avgFirst - avgSecond > 0.3) trend = "improving";
          else if (avgSecond - avgFirst > 0.3) trend = "declining";
          else trend = "stable";
        }
      }

      const exScores = exerciseScoresByDim[dim.name];
      const exerciseScore =
        exScores.length > 0 ? exScores.reduce((s, v) => s + v, 0) / exScores.length : null;

      let finalScore: number;
      if (exerciseScore !== null && hasWritingData) {
        finalScore = Math.round(writingScore * 0.7 + exerciseScore * 0.3);
      } else if (hasWritingData) {
        finalScore = Math.round(writingScore);
      } else if (exerciseScore !== null) {
        finalScore = Math.round(exerciseScore);
      } else {
        finalScore = 50;
      }

      return { dimension: dim.name, score: finalScore, trend, color: dim.color };
    });
  }, [parsedWriting, parsedExercises, parsedListening, parsedSpeaking]);

  // === Best / worst dimension ===
  const bestDimension = useMemo(() => {
    if (capabilityData.length === 0) return "";
    if (!capabilityData.some((d) => d.score !== 50)) return "暂无足够数据";
    return capabilityData.reduce((best, d) => (d.score > best.score ? d : best)).dimension;
  }, [capabilityData]);

  const worstDimension = useMemo(() => {
    if (capabilityData.length === 0) return "";
    if (!capabilityData.some((d) => d.score !== 50)) return "暂无足够数据";
    return capabilityData.reduce((worst, d) => (d.score < worst.score ? d : worst)).dimension;
  }, [capabilityData]);

  return {
    parsedExercises,
    exerciseTrendData,
    capabilityData,
    bestDimension,
    worstDimension,
  };
}
