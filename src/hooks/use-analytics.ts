/**
 * useAnalytics —— 从历史记录中派生所有学习分析数据。
 *
 * 将 AnalyticsPage 中散落的 useMemo 计算链集中到一个 hook 中，
 * 输入为 allRecords（所有历史记录），输出为各图表/统计所需的结构化数据。
 */
import { useEffect, useMemo, useState } from "react";
import {
  type CapabilityPoint,
  type CategoryStat,
  DIMENSION_CONFIG,
  DIMENSION_MAP,
  isExerciseResult,
  isListeningResult,
  parseResult,
  type ScoreTrendPoint,
  type SessionDetail,
  type TrendPoint,
} from "@/lib/analytics";
import { getHistory } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import type { CorrectionResult, ExerciseResult, HistoryRecord, ListeningResult } from "@/types";

/** useAnalytics 的返回值 */
export interface AnalyticsData {
  loading: boolean;
  allRecords: HistoryRecord[];
  // 按类型分类
  correctRecords: HistoryRecord[];
  exerciseRecords: HistoryRecord[];
  listeningRecords: HistoryRecord[];
  readingRecords: HistoryRecord[];
  // 写作纠错分析
  parsed: { record: HistoryRecord; result: CorrectionResult }[];
  totalArticles: number;
  totalErrors: number;
  avgErrors: string;
  uniqueCategories: number;
  categoryData: CategoryStat[];
  trendData: TrendPoint[];
  improvement: { diff: number; pct: string; avgFirst: string; avgSecond: string } | null;
  // 练习/听力成绩趋势
  exerciseTrendData: ScoreTrendPoint[];
  listeningTrendData: ScoreTrendPoint[];
  // 学习画像
  capabilityData: CapabilityPoint[];
  bestDimension: string;
  worstDimension: string;
  // 近期记录
  recentSessions: SessionDetail[];
  // 弱项推荐
  weakCategories: { name: string; count: number }[];
}

export function useAnalytics(): AnalyticsData {
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHistory()
      .then((r) => {
        setAllRecords(r);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  // === 按类型分类 ===
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

  // === 写作纠错分析 ===
  const parsed = useMemo(() => {
    return correctRecords
      .map((r) => ({ record: r, result: parseResult(r.result) }))
      .filter((x): x is { record: HistoryRecord; result: CorrectionResult } => x.result !== null);
  }, [correctRecords]);

  const totalArticles = parsed.length;
  const totalErrors = parsed.reduce((sum, p) => sum + p.result.corrections.length, 0);
  const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";

  const allCategories = useMemo(() => {
    const map = new Map<string, number>();
    parsed.forEach((p) => {
      p.result.corrections.forEach((c) => {
        map.set(c.category, (map.get(c.category) ?? 0) + 1);
      });
    });
    return map;
  }, [parsed]);

  const uniqueCategories = allCategories.size;

  const categoryData: CategoryStat[] = useMemo(() => {
    return Array.from(allCategories.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allCategories]);

  const trendData: TrendPoint[] = useMemo(() => {
    const sorted = [...parsed].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );
    return sorted.map((p, i) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      errors: p.result.corrections.length,
      index: i + 1,
    }));
  }, [parsed]);

  const improvement = useMemo(() => {
    if (trendData.length < 2) return null;
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid);
    const secondHalf = trendData.slice(mid);
    const avgFirst = firstHalf.reduce((s, d) => s + d.errors, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d.errors, 0) / secondHalf.length;
    const diff = avgFirst - avgSecond;
    const pct = avgFirst > 0 ? ((diff / avgFirst) * 100).toFixed(0) : "0";
    return { diff, pct, avgFirst: avgFirst.toFixed(1), avgSecond: avgSecond.toFixed(1) };
  }, [trendData]);

  // === 弱项训练成绩趋势 ===
  const exerciseTrendData: ScoreTrendPoint[] = useMemo(() => {
    const parsedExercises = exerciseRecords
      .map((r) => ({
        record: r,
        result: extractJson<ExerciseResult>(r.result, isExerciseResult),
      }))
      .filter((x): x is { record: HistoryRecord; result: ExerciseResult } => x.result !== null);

    const sorted = parsedExercises.sort(
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
  }, [exerciseRecords]);

  // === 听力练习成绩趋势 ===
  const listeningTrendData: ScoreTrendPoint[] = useMemo(() => {
    const parsedListening = listeningRecords
      .map((r) => ({
        record: r,
        result: extractJson<ListeningResult>(r.result, isListeningResult),
      }))
      .filter((x): x is { record: HistoryRecord; result: ListeningResult } => x.result !== null);

    const sorted = parsedListening.sort(
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
  }, [listeningRecords]);

  // === 学习画像（能力雷达图） ===
  const capabilityData = useMemo<CapabilityPoint[]>(() => {
    const dimensionErrorsPerArticle: Record<string, number[]> = {};
    for (const dim of DIMENSION_CONFIG) {
      dimensionErrorsPerArticle[dim.name] = [];
    }

    const sortedParsed = [...parsed].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime(),
    );

    for (const p of sortedParsed) {
      const dimCounts: Record<string, number> = {};
      for (const dim of DIMENSION_CONFIG) dimCounts[dim.name] = 0;
      for (const c of p.result.corrections) {
        const dim = DIMENSION_MAP[c.category];
        if (dim) dimCounts[dim] = (dimCounts[dim] ?? 0) + 1;
      }
      for (const dim of DIMENSION_CONFIG) {
        dimensionErrorsPerArticle[dim.name].push(dimCounts[dim.name]);
      }
    }

    const dimensionAvgErrors: Record<string, number> = {};
    let maxAvg = 0;
    for (const dim of DIMENSION_CONFIG) {
      const errors = dimensionErrorsPerArticle[dim.name];
      const avg = errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : 0;
      dimensionAvgErrors[dim.name] = avg;
      if (avg > maxAvg) maxAvg = avg;
    }

    const exerciseScoresByDim: Record<string, number[]> = {};
    for (const dim of DIMENSION_CONFIG) exerciseScoresByDim[dim.name] = [];
    for (const r of exerciseRecords) {
      const result = extractJson<ExerciseResult>(r.result, isExerciseResult);
      if (!result) continue;
      const dim = DIMENSION_MAP[result.category];
      if (!dim) continue;
      const pct = result.exercises.length > 0 ? (result.score / result.exercises.length) * 100 : 0;
      exerciseScoresByDim[dim].push(pct);
    }

    return DIMENSION_CONFIG.map((dim) => {
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
  }, [parsed, exerciseRecords]);

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

  // === 近期记录 ===
  const recentSessions: SessionDetail[] = useMemo(() => {
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
        const result = parseResult(r.result);
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
        const result = extractJson<ExerciseResult>(r.result, isExerciseResult);
        if (result) {
          base.score = result.score;
          base.total = result.exercises.length;
        }
      } else if (r.type === "listening") {
        const result = extractJson<ListeningResult>(r.result, isListeningResult);
        if (result) {
          base.score = result.score;
          base.total = result.sentences.length;
        }
      }
      return base;
    });
  }, [allRecords]);

  // === 弱项推荐 ===
  const weakCategories = useMemo(() => {
    const recent = [...parsed]
      .sort(
        (a, b) => new Date(b.record.created_at).getTime() - new Date(a.record.created_at).getTime(),
      )
      .slice(0, 10);
    if (recent.length === 0) return [];
    const catMap = new Map<string, number>();
    recent.forEach((p) => {
      p.result.corrections.forEach((c) => {
        catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
      });
    });
    return Array.from(catMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 2);
  }, [parsed]);

  return {
    loading,
    allRecords,
    correctRecords,
    exerciseRecords,
    listeningRecords,
    readingRecords,
    parsed,
    totalArticles,
    totalErrors,
    avgErrors,
    uniqueCategories,
    categoryData,
    trendData,
    improvement,
    exerciseTrendData,
    listeningTrendData,
    capabilityData,
    bestDimension,
    worstDimension,
    recentSessions,
    weakCategories,
  };
}
