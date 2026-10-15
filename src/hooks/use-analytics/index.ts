/**
 * useAnalytics orchestrator hook.
 *
 * 优化策略：
 * 1. 用 getHistoryWithResults 一次取回不含 result/graph_data 的轻量记录
 *    （元数据+时间）与按 id 配好对的 result 内容
 * 2. 记录查询覆盖六类（含 reading，供阅读统计与近期会话展示）；
 *    仅对需要解析 result 的类型（correct/writing/exercise/listening/speaking）拉取，
 *    reading 的重型 Markdown result 只用于详情页，分析页不需要（经 resultTypes 区分）
 * 3. 编排层基于 [allRecords, resultById] 一次性解析全部记录（parsedAll），
 *    再基于 [parsedAll, days] 按 created_at 过滤出各类型已解析数组，子 hook 直接消费——
 *    切换时间范围(days)时只做数组过滤，不再重复 JSON.parse（P0 性能优化）
 * 4. resultLimit=150：元数据窗口 500 条，重型 result 只拉最近 150 条，
 *    压低 Tauri IPC 载荷与主线程 Zod 校验量；更老的记录无 result 时
 *    parsedAll 自动跳过，时间轴上的元数据统计不受影响
 */

import { useEffect, useMemo, useState } from "react";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import {
  type CapabilityPoint,
  type CategoryStat,
  parseResult,
  type ScoreTrendPoint,
  type SessionDetail,
  type TrendPoint,
} from "@/lib/analytics";
import { getHistoryWithResults, parseDbTimestamp } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { applyMasteryWeight, type CategoryMastery, type WrongQuestion } from "@/lib/exercise-stats";
import { extractJsonSafe } from "@/lib/parse-utils";
import { ExerciseResultSchema, ListeningResultSchema, SpeakingResultSchema } from "@/lib/schemas";
import type { HistoryRecord } from "@/types";
import { type ParsedExercise, useExerciseAnalytics } from "./use-exercise-analytics";
import { type ParsedListening, useListeningAnalytics } from "./use-listening-analytics";
import { useRecentSessions } from "./use-recent-sessions";
import { type ParsedSpeaking, useSpeakingAnalytics } from "./use-speaking-analytics";
import { type ParsedCorrection, useWritingAnalytics } from "./use-writing-analytics";

/** 重型 result 拉取上限（与下方 getHistoryWithResults 的 resultLimit 实参一致） */
const RESULT_LIMIT = 150;

/**
 * AnalyticsData — useAnalytics hook 的返回类型，由各子 hook 聚合而成。
 *
 * 包含所有学习分析维度的统计数据，供 AnalyticsPage 直接消费。
 */
export interface AnalyticsData {
  /** 是否正在加载历史记录 */
  loading: boolean;
  /** 历史记录加载失败的错误信息（null 表示无错误）。
   *  失败时不应伪装成"暂无数据"空状态——调用方需渲染错误态。 */
  error: string | null;
  /** 重新加载（错误态重试入口） */
  reload: () => void;
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
  /** 薄弱类别推荐（写作错误频次经练习掌握度降权后的 top 2） */
  weakCategories: { name: string; count: number; mastery: CategoryMastery | null }[];
  /** 练习错题列表（最新在前） */
  wrongQuestions: WrongQuestion[];
  /** 详细结果窗口是否被 resultLimit 截断（为真时趋势/分布/进步指标仅覆盖最近 RESULT_LIMIT 条记录） */
  resultsWindowLimited: boolean;
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
  // === Data fetching: 轻量记录 + 按 id 配对的 result，一次调用完成 ===
  // result 存于 Map<record id, result>，子 hook 经查找函数按 id 取用。
  // P0 修复：此前用 string[] 按下标配对，依赖"两次查询顺序与类型集一致"——
  // correctRecords 过滤 correct||writing 而 result 查询只取 correct，混入 legacy
  // writing 记录时整体错位；两次查询间隙插入新记录也会错位。按 id 关联彻底消除。
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [resultById, setResultById] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // 乱序响应守卫：reload() 连点、错误态重试与挂载加载可能交错，慢的旧响应
  // 不允许覆盖新结果——用 useStaleGuard 序号守卫丢弃过期响应（机制文档归
  // hook 所有）。
  const { begin, isStale } = useStaleGuard();

  useEffect(() => {
    const seq = begin();
    setLoadError(null);
    // reloadToken 是重触发令牌：值本身不参与数据逻辑（引用以满足依赖分析），
    // reload() 递增令牌使本 effect 重新执行数据加载
    void reloadToken;
    // 单次调用取回轻量记录与按 id 配对好的 result。此前四路
    // getHistoryResultsByType 各自 catch-and-continue 的降级语义已由
    // getHistoryWithResults 内部承接（result 失败 → 空 Map，记录照常返回），
    // 仅记录列表本身失败才走 error 分支。
    // recordTypes 含 reading（统计/近期会话需要其元数据），resultTypes 不含
    // reading（其重型 Markdown result 仅详情页需要，分析页不拉取）。
    //
    // resultLimit 与记录 limit 分离：元数据窗口 500 条（覆盖近期会话/类型计数），
    // 重型 result 只拉最近 150 条（足够错误分布/分数趋势；再老的记录无 result
    // 时 parsedAll 自动跳过，不影响时间轴上的元数据统计）——避免 500 条
    // 多 KB JSON 一次性穿过 Tauri IPC + 主线程 Zod 校验。
    getHistoryWithResults(
      ["correct", "writing", "exercise", "listening", "speaking", "reading"],
      500,
      ["correct", "writing", "exercise", "listening", "speaking"],
      RESULT_LIMIT,
    )
      .then(({ records, resultById: byId }) => {
        // 过期响应直接丢弃：期间又有更新的请求发起（连点 reload），
        // 旧数据落盘会瞬间覆盖新数据，造成界面回跳
        if (isStale(seq)) return;
        setAllRecords(records);
        setResultById(byId);
        setLoading(false);
      })
      .catch((err) => {
        if (isStale(seq)) return;
        console.warn("useAnalytics: getHistoryWithResults failed", err);
        setLoadError(getErrorMessage(err, "历史记录加载失败"));
        setLoading(false);
      });
  }, [reloadToken, begin, isStale]);

  // === Filter by time range (days=0 means all time) ===
  const filteredRecords = useMemo(() => {
    if (days <= 0) return allRecords;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return allRecords.filter((r) => parseDbTimestamp(r.created_at) >= cutoff);
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

  // === Parse all relevant results once (independent of days) ===
  // 一次性解析全部记录（500 条）的 result；days 变化只触发下方按 created_at 过滤，
  // 不再重复 JSON.parse。未命中 resultById（超出 resultLimit 的较老记录）时跳过——
  // 轻量查询返回 '' AS result 而非 null，回退到 record.result 没有意义。
  const parsedAll = useMemo(() => {
    const correct: ParsedCorrection[] = [];
    const exercise: ParsedExercise[] = [];
    const listening: ParsedListening[] = [];
    const speaking: ParsedSpeaking[] = [];
    for (const r of allRecords) {
      const raw = resultById.get(r.id);
      if (raw === undefined) continue;
      if (r.type === "correct" || r.type === "writing") {
        const result = parseResult(raw);
        if (result !== null) correct.push({ record: r, result });
      } else if (r.type === "exercise") {
        const result = extractJsonSafe(raw, ExerciseResultSchema);
        if (result !== null) exercise.push({ record: r, result });
      } else if (r.type === "listening") {
        const result = extractJsonSafe(raw, ListeningResultSchema);
        if (result !== null) listening.push({ record: r, result });
      } else if (r.type === "speaking") {
        const result = extractJsonSafe(raw, SpeakingResultSchema);
        if (result !== null) speaking.push({ record: r, result });
      }
    }
    return { correct, exercise, listening, speaking };
  }, [allRecords, resultById]);

  // === Filter parsed results by time range (days=0 means all time) ===
  // 与上方 filteredRecords 使用同一 cutoff，保证各类型 parsed 与记录筛选口径一致
  const parsedByType = useMemo(() => {
    if (days <= 0) return parsedAll;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const inRange = (p: { record: HistoryRecord }) =>
      parseDbTimestamp(p.record.created_at) >= cutoff;
    return {
      correct: parsedAll.correct.filter(inRange),
      exercise: parsedAll.exercise.filter(inRange),
      listening: parsedAll.listening.filter(inRange),
      speaking: parsedAll.speaking.filter(inRange),
    };
  }, [parsedAll, days]);

  const parsedCorrect = parsedByType.correct;
  const parsedExercise = parsedByType.exercise;
  const parsedListening = parsedByType.listening;
  const parsedSpeaking = parsedByType.speaking;

  // result 窗口截断标志：取到的 result 数达到上限即视为可能截断（恰为上限时无法区分
  // 是否还有更多）；result 数为 0（含查询失败降级）时自然为 false
  const resultsWindowLimited = resultById.size >= RESULT_LIMIT;

  // === Delegate to sub-hooks（直接消费编排层已解析并过滤后的数组） ===
  const writing = useWritingAnalytics(parsedCorrect);
  const listening = useListeningAnalytics(parsedListening);
  const speaking = useSpeakingAnalytics(parsedSpeaking);
  const exercise = useExerciseAnalytics(
    parsedExercise,
    parsedCorrect,
    parsedListening,
    parsedSpeaking,
  );
  const recent = useRecentSessions(
    filteredRecords,
    writing.parsed,
    exercise.parsedExercises,
    listening.parsedListening,
    speaking.parsedSpeaking,
  );

  // === Weak categories: 写作错误频次 × 练习掌握度降权（P0-1） ===
  // 已通过练习证明掌握的类别权重减半，让推荐位轮换给真正的薄弱项
  const weakCategories = useMemo(
    () => applyMasteryWeight(writing.weakCategories, exercise.categoryMastery).slice(0, 2),
    [writing.weakCategories, exercise.categoryMastery],
  );

  // 整体 memoize 返回对象：子 hook 各字段已单独 memoized（标量按值比较），
  // 避免每次渲染产生新引用导致消费方（如 AnalyticsPage 切换时间范围外的 state 变化时）
  // 的下游 memo/依赖判定失效。
  return useMemo(
    () => ({
      loading,
      error: loadError,
      reload: () => setReloadToken((t) => t + 1),
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
      weakCategories,
      // Exercise analytics
      exerciseTrendData: exercise.exerciseTrendData,
      capabilityData: exercise.capabilityData,
      bestDimension: exercise.bestDimension,
      worstDimension: exercise.worstDimension,
      wrongQuestions: exercise.wrongQuestions,
      // Listening analytics
      listeningTrendData: listening.listeningTrendData,
      // Speaking analytics
      speakingRecords,
      speakingTrendData: speaking.speakingTrendData,
      // Cross-type
      recentSessions: recent.recentSessions,
      resultsWindowLimited,
    }),
    [
      loading,
      loadError,
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
      weakCategories,
      exercise.exerciseTrendData,
      exercise.capabilityData,
      exercise.bestDimension,
      exercise.worstDimension,
      exercise.wrongQuestions,
      listening.listeningTrendData,
      speaking.speakingTrendData,
      recent.recentSessions,
      resultsWindowLimited,
    ],
  );
}
