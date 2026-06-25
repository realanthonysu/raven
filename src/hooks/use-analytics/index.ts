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
import { useSpeakingAnalytics } from "./use-speaking-analytics";
import { useWritingAnalytics } from "./use-writing-analytics";

/** AnalyticsData — useAnalytics hook 的返回类型，由各子 hook 聚合而成。 */
export interface AnalyticsData {
  loading: boolean;
  allRecords: HistoryRecord[];
  correctRecords: HistoryRecord[];
  exerciseRecords: HistoryRecord[];
  listeningRecords: HistoryRecord[];
  readingRecords: HistoryRecord[];
  speakingRecords: HistoryRecord[];
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
  speakingTrendData: ScoreTrendPoint[];
  capabilityData: CapabilityPoint[];
  bestDimension: string;
  worstDimension: string;
  recentSessions: SessionDetail[];
  weakCategories: { name: string; count: number }[];
}

export function useAnalytics(days: number = 0): AnalyticsData {
  // === Data fetching ===
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHistory(undefined, 500)
      .then((r) => {
        setAllRecords(r);
        setLoading(false);
      })
      .catch((err) => {
        console.warn("useAnalytics: getHistory failed", err);
        setLoading(false);
      });
  }, []);

  // === Filter by time range (days=0 means all time) ===
  const filteredRecords = useMemo(() => {
    if (days <= 0) return allRecords;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return allRecords.filter((r) => new Date(r.created_at) >= cutoff);
  }, [allRecords, days]);

  // === Filter records by type ===
  const correctRecords = useMemo(
    () => filteredRecords.filter((r) => r.type === "correct" || r.type === "writing"),
    [filteredRecords],
  );
  const exerciseRecords = useMemo(
    () => filteredRecords.filter((r) => r.type === "exercise"),
    [filteredRecords],
  );
  const listeningRecords = useMemo(
    () => filteredRecords.filter((r) => r.type === "listening"),
    [filteredRecords],
  );
  const readingRecords = useMemo(
    () => filteredRecords.filter((r) => r.type === "reading"),
    [filteredRecords],
  );
  const speakingRecords = useMemo(
    () => filteredRecords.filter((r) => r.type === "speaking"),
    [filteredRecords],
  );

  // === Delegate to sub-hooks ===
  const writing = useWritingAnalytics(correctRecords);
  const listening = useListeningAnalytics(listeningRecords);
  const speaking = useSpeakingAnalytics(speakingRecords);
  const exercise = useExerciseAnalytics(
    exerciseRecords,
    writing.parsed,
    listening.parsedListening,
    speaking.parsedSpeaking,
  );
  const recent = useRecentSessions(
    filteredRecords,
    writing.parsed,
    exercise.parsedExercises,
    listening.parsedListening,
    speaking.parsedSpeaking,
  );

  return {
    loading,
    allRecords: filteredRecords,
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
    // Speaking analytics
    speakingRecords,
    speakingTrendData: speaking.speakingTrendData,
    // Cross-type
    recentSessions: recent.recentSessions,
  };
}
