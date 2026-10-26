/**
 * useAnalytics orchestrator hook.
 *
 * 优化策略：
 * 1. 数据窗口（六类元数据 + 五类 result、stale 守卫、fail-soft 错误、reload、
 *    result 窗口截断旗标）由共享的 useHistoryWindow 单一持有 —— 此前与本文件
 *    及 use-level-estimation 各自手写的加载脚手架已收敛进该 hook，窗口条数
 *    取 lib/db/history 的 HISTORY_RECORD_LIMIT(500) / HISTORY_RESULT_LIMIT(150)
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

import { useMemo } from "react";
import { useHistoryWindow } from "@/hooks/use-history-window";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import type {
  CapabilityPoint,
  CategoryStat,
  ScoreTrendPoint,
  SessionDetail,
  TrendPoint,
} from "@/lib/analytics";
import { parseDbTimestamp } from "@/lib/db";
import { type CategoryMastery, rankWeakCategories, type WrongQuestion } from "@/lib/exercise-stats";
import type { LevelUpSuggestion, SkillEstimate } from "@/lib/level-estimation";
import { buildSkillEstimates, groupAndParseResults } from "@/lib/level-estimation-samples";
import type { HistoryRecord } from "@/types";
import { useExerciseAnalytics } from "./use-exercise-analytics";
import { useListeningAnalytics } from "./use-listening-analytics";
import { useRecentSessions } from "./use-recent-sessions";
import { useSpeakingAnalytics } from "./use-speaking-analytics";
import { useWritingAnalytics } from "./use-writing-analytics";

/** 弱项训练推荐的统计窗口：只看最近 10 篇写作（Analytics 展示口径；
 *  Dashboard 的"最弱项"用 20 篇/top1，参数差异刻意、管线共享 rankWeakCategories） */
const WEAK_CATEGORY_WINDOW = 10;
/** 弱项训练推荐条数：降权后取 top 2 */
const WEAK_CATEGORY_TOP_N = 2;

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
  /** 各技能级别估计（样本不足的技能不在其中；被动定级，供 LevelProgressCard 雷达图） */
  levelEstimates: SkillEstimate[];
  /** 由当前级别 + 各技能估计生成的升级建议（显式推荐，用户一键应用） */
  levelSuggestions: LevelUpSuggestion[];
  /** 详细结果窗口是否被 resultLimit 截断（为真时趋势/分布/进步指标仅覆盖最近 HISTORY_RESULT_LIMIT 条记录） */
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
  // === Data fetching: 窗口协议委托给 useHistoryWindow（单一 owner） ===
  // result 存于 Map<record id, result>，子 hook 经查找函数按 id 取用。
  // P0 修复：此前用 string[] 按下标配对，依赖"两次查询顺序与类型集一致"——
  // correctRecords 过滤 correct||writing 而 result 查询只取 correct，混入 legacy
  // writing 记录时整体错位；两次查询间隙插入新记录也会错位。按 id 关联彻底消除。
  const {
    records: allRecords,
    resultById,
    loading,
    error: loadError,
    reload,
    resultsWindowLimited,
  } = useHistoryWindow();
  const { level } = useProficiencyLevel();

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
  // 按类型分 schema 的解析派发在 lib/level-estimation-samples 的
  // groupAndParseResults（与 LevelCard 侧被动估计共用）；本编排层不消费 reading
  // 段（其记录由 filteredRecords 按类型派生），故只取前四类。
  const parsedAll = useMemo(() => {
    const { correct, exercise, listening, speaking } = groupAndParseResults(allRecords, resultById);
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

  // === 分技能级别估计（Phase 3/4）：复用编排层已解析数组，按当前级别生成建议 ===
  // 原子 hook（use-level-analytics）只是对 buildSkillEstimates 的单层委托，
  // 已内联：编排层直接调 lib/level-estimation-samples 的纯函数核心。
  const { estimates: levelEstimates, suggestions: levelSuggestions } = useMemo(
    () =>
      buildSkillEstimates(
        {
          correct: parsedCorrect,
          exercise: parsedExercise,
          listening: parsedListening,
          speaking: parsedSpeaking,
          reading: readingRecords,
        },
        level,
      ),
    [parsedCorrect, parsedExercise, parsedListening, parsedSpeaking, readingRecords, level],
  );

  // === Weak categories: 写作错误频次 × 练习掌握度降权（P0-1） ===
  // 已通过练习证明掌握的类别权重减半，让推荐位轮换给真正的薄弱项。
  // 管线与 Dashboard 的"最弱项"共用 lib/exercise-stats 的 rankWeakCategories，
  // 仅窗口/topN 展示参数不同（此处 10 篇 / top2，Dashboard 20 篇 / top1）。
  const weakCategories = useMemo(() => {
    // 防御性重排为最新在前（rankWeakCategories 取开头 window 篇作"最近 N 篇"）
    const sortedNewestFirst = [...parsedCorrect].sort(
      (a, b) =>
        parseDbTimestamp(b.record.created_at).getTime() -
        parseDbTimestamp(a.record.created_at).getTime(),
    );
    return rankWeakCategories({
      categoriesPerArticle: sortedNewestFirst.map((p) =>
        p.result.corrections.map((c) => c.category),
      ),
      exerciseAttempts: parsedExercise.map((p) => ({
        category: p.result.category,
        score: p.result.score,
        total: p.result.exercises.length,
        createdAt: p.record.created_at,
      })),
      window: WEAK_CATEGORY_WINDOW,
      topN: WEAK_CATEGORY_TOP_N,
    });
  }, [parsedCorrect, parsedExercise]);

  // 整体 memoize 返回对象：子 hook 各字段已单独 memoized（标量按值比较），
  // 避免每次渲染产生新引用导致消费方（如 AnalyticsPage 切换时间范围外的 state 变化时）
  // 的下游 memo/依赖判定失效。
  return useMemo(
    () => ({
      loading,
      error: loadError,
      reload,
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
      levelEstimates,
      levelSuggestions,
      resultsWindowLimited,
    }),
    [
      loading,
      loadError,
      reload, // useHistoryWindow 以 useCallback 固定身份，安全入列
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
      levelEstimates,
      levelSuggestions,
      resultsWindowLimited,
    ],
  );
}
