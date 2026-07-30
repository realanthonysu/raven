/**
 * useAnalytics orchestrator hook.
 *
 * 优化策略：
 * 1. 先用 getHistoryList 获取不含 result/graph_data 的轻量记录（元数据+时间）
 * 2. 仅对需要解析 result 的类型（writing/exercise/listening/speaking）按需获取
 * 3. 将 result 字符串注入对应子 hook，避免一次性传输全部500条完整记录
 */

import { useEffect, useMemo, useState } from "react";
import type {
  CapabilityPoint,
  CategoryStat,
  ScoreTrendPoint,
  SessionDetail,
  TrendPoint,
} from "@/lib/analytics";
import { getHistoryList, getHistoryResultsByType } from "@/lib/db";
import type { HistoryRecord } from "@/types";
import { useExerciseAnalytics } from "./use-exercise-analytics";
import { useListeningAnalytics } from "./use-listening-analytics";
import { useRecentSessions } from "./use-recent-sessions";
import { useSpeakingAnalytics } from "./use-speaking-analytics";
import { useWritingAnalytics } from "./use-writing-analytics";

/**
 * AnalyticsData — useAnalytics hook 的返回类型，由各子 hook 聚合而成。
 *
 * 包含所有学习分析维度的统计数据，供 AnalyticsPage 直接消费。
 */
export interface AnalyticsData {
  /** 是否正在加载历史记录 */
  loading: boolean;
  /** 筛选后的全部历史记录 */
  allRecords: HistoryRecord[];
  /** 写作批改记录 */
  correctRecords: HistoryRecord[];
  /** 练习记录 */
  exerciseRecords: HistoryRecord[];
  /** 听力记录 */
  listeningRecords: HistoryRecord[];
  /** 阅读记录 */
  readingRecords: HistoryRecord[];
  /** 口语记录 */
  speakingRecords: HistoryRecord[];
  /** 已解析的写作批改记录（含 CorrectionResult） */
  parsed: { record: HistoryRecord; result: import("@/types").CorrectionResult }[];
  /** 写作批改总篇数 */
  totalArticles: number;
  /** 写作批改总错误数 */
  totalErrors: number;
  /** 平均每篇错误数（字符串，保留一位小数） */
  avgErrors: string;
  /** 错误类别数 */
  uniqueCategories: number;
  /** 错误类别分布数据（按数量降序） */
  categoryData: CategoryStat[];
  /** 写作错误趋势数据 */
  trendData: TrendPoint[];
  /** 写作进步指标（前半段 vs 后半段对比），数据不足时为 null */
  improvement: { diff: number; pct: string; avgFirst: string; avgSecond: string } | null;
  /** 练习分数趋势数据 */
  exerciseTrendData: ScoreTrendPoint[];
  /** 听力分数趋势数据 */
  listeningTrendData: ScoreTrendPoint[];
  /** 口语分数趋势数据 */
  speakingTrendData: ScoreTrendPoint[];
  /** 六维能力雷达图数据 */
  capabilityData: CapabilityPoint[];
  /** 最强维度名称 */
  bestDimension: string;
  /** 最弱维度名称 */
  worstDimension: string;
  /** 最近 15 次学习记录摘要 */
  recentSessions: SessionDetail[];
  /** 薄弱类别推荐（最近 10 篇中最常出错的 2 个类别） */
  weakCategories: { name: string; count: number }[];
}

/**
 * 学习分析编排 hook —— 聚合所有维度的分析数据。
 *
 * 从数据库获取历史记录，按时间范围筛选后分发给各子 hook
 * （useWritingAnalytics、useExerciseAnalytics、useListeningAnalytics、
 * useSpeakingAnalytics、useRecentSessions），返回合并后的分析结果。
 *
 * @param days - 时间范围（天数），0 表示不限制（全部数据）
 * @returns 包含所有分析维度数据的 AnalyticsData 对象
 */
export function useAnalytics(days: number = 0): AnalyticsData {
  // === Data fetching: 轻量记录 + 按需获取 result ===
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [writingResults, setWritingResults] = useState<string[]>([]);
  const [exerciseResults, setExerciseResults] = useState<string[]>([]);
  const [listeningResults, setListeningResults] = useState<string[]>([]);
  const [speakingResults, setSpeakingResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 第一步：获取轻量记录（不含 result/graph_data，仅 IPC 传输元数据）
    getHistoryList(undefined, 500)
      .then(async (records) => {
        setAllRecords(records);

        // 第二步：按需获取需要解析 result 的类型（Rust 端按 created_at DESC 排序）
        // 结果字符串与对应类型的记录一一对应（同排序、同过滤），子 hook 中合并使用
        const typeConfigs = [
          { type: "correct", setter: setWritingResults },
          { type: "exercise", setter: setExerciseResults },
          { type: "listening", setter: setListeningResults },
          { type: "speaking", setter: setSpeakingResults },
        ] as const;

        await Promise.all(
          typeConfigs.map(async ({ type, setter }) => {
            try {
              const results = await getHistoryResultsByType(type, 500);
              setter(results);
            } catch {
              // 降级：result 获取失败不影响页面渲染（子 hook 处理空数组）
            }
          }),
        );
        setLoading(false);
      })
      .catch((err) => {
        console.warn("useAnalytics: getHistoryList failed", err);
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

  // === Delegate to sub-hooks（传入预获取的 result 字符串，避免子 hook 读取空的 record.result） ===
  const writing = useWritingAnalytics(correctRecords, writingResults);
  const listening = useListeningAnalytics(listeningRecords, listeningResults);
  const speaking = useSpeakingAnalytics(speakingRecords, speakingResults);
  const exercise = useExerciseAnalytics(
    exerciseRecords,
    writing.parsed,
    listening.parsedListening,
    speaking.parsedSpeaking,
    exerciseResults,
  );
  const recent = useRecentSessions(
    filteredRecords,
    writing.parsed,
    exercise.parsedExercises,
    listening.parsedListening,
    speaking.parsedSpeaking,
  );

  // 整体 memoize 返回对象：子 hook 各字段已单独 memoized（标量按值比较），
  // 避免每次渲染产生新引用导致消费方（如 AnalyticsPage 切换时间范围外的 state 变化时）
  // 的下游 memo/依赖判定失效。
  return useMemo(
    () => ({
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
    }),
    [
      loading,
      filteredRecords,
      correctRecords,
      exerciseRecords,
      listeningRecords,
      readingRecords,
      speakingRecords,
      writing.parsed,
      writing.totalArticles,
      writing.totalErrors,
      writing.avgErrors,
      writing.uniqueCategories,
      writing.categoryData,
      writing.trendData,
      writing.improvement,
      writing.weakCategories,
      exercise.exerciseTrendData,
      exercise.capabilityData,
      exercise.bestDimension,
      exercise.worstDimension,
      listening.listeningTrendData,
      speaking.speakingTrendData,
      recent.recentSessions,
    ],
  );
}
