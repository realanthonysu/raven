/**
 * useAnalytics orchestrator hook.
 *
 * Fetches all history records from the database and delegates
 * to focused sub-hooks for domain-specific analytics. Returns
 * the combined AnalyticsData interface, preserving full backward
 * compatibility with AnalyticsPage.tsx.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  CapabilityPoint,
  CategoryStat,
  ScoreTrendPoint,
  SessionDetail,
  TrendPoint,
} from "@/lib/analytics";
import { getHistory } from "@/lib/db";
import type { HistoryRecord } from "@/types";
import { useExerciseAnalytics } from "./use-exercise-analytics";
import { useListeningAnalytics } from "./use-listening-analytics";
import { useRecentSessions } from "./use-recent-sessions";
import { useWritingAnalytics } from "./use-writing-analytics";

/** Backward-compatible return type — identical to the original AnalyticsData. */
export interface AnalyticsData {
  loading: boolean;
  allRecords: HistoryRecord[];
  correctRecords: HistoryRecord[];
  exerciseRecords: HistoryRecord[];
  listeningRecords: HistoryRecord[];
  readingRecords: HistoryRecord[];
  parsed: { record: HistoryRecord; result: import("@/types").CorrectionResult }[];
  totalArticles: number;
  totalErrors: number;
  avgErrors: string;
  uniqueCategories: number;
  categoryData: CategoryStat[];
  trendData: TrendPoint[];
  improvement: { diff: number; pct: string; avgFirst: string; avgSecond: string } | null;
  exerciseTrendData: ScoreTrendPoint[];
  listeningTrendData: ScoreTrendPoint[];
  capabilityData: CapabilityPoint[];
  bestDimension: string;
  worstDimension: string;
  recentSessions: SessionDetail[];
  weakCategories: { name: string; count: number }[];
}

export function useAnalytics(): AnalyticsData {
  // === Data fetching ===
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHistory(undefined, 500)
      .then((r) => {
        setAllRecords(r);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  // === Filter records by type ===
  const correctRecords = useMemo(
    () => allRecords.filter((r) => r.type === "correct"),
    [allRecords],
  );
  const exerciseRecords = useMemo(
    () => allRecords.filter((r) => r.type === "exercise"),
    [allRecords],
  );
  const listeningRecords = useMemo(
    () => allRecords.filter((r) => r.type === "listening"),
    [allRecords],
  );
  const readingRecords = useMemo(
    () => allRecords.filter((r) => r.type === "reading"),
    [allRecords],
  );

  // === Delegate to sub-hooks ===
  const writing = useWritingAnalytics(correctRecords);
  const exercise = useExerciseAnalytics(exerciseRecords, writing.parsed);
  const listening = useListeningAnalytics(listeningRecords);
  const recent = useRecentSessions(
    allRecords,
    writing.parsed,
    exercise.parsedExercises,
    listening.parsedListening,
  );

  return {
    loading,
    allRecords,
    correctRecords,
    exerciseRecords,
    listeningRecords,
    readingRecords,
    // Writing analytics
    parsed: writing.parsed,
    totalArticles: writing.totalArticles,
    totalErrors: writing.totalErrors,
    avgErrors: writing.avgErrors,
    uniqueCategories: writing.uniqueCategories,
    categoryData: writing.categoryData,
    trendData: writing.trendData,
    improvement: writing.improvement,
    weakCategories: writing.weakCategories,
    // Exercise analytics
    exerciseTrendData: exercise.exerciseTrendData,
    capabilityData: exercise.capabilityData,
    bestDimension: exercise.bestDimension,
    worstDimension: exercise.worstDimension,
    // Listening analytics
    listeningTrendData: listening.listeningTrendData,
    // Cross-type
    recentSessions: recent.recentSessions,
  };
}
