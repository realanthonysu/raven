/**
 * 练习统计纯函数模块 —— 弱项掌握度追踪、推荐降权与错题收集。
 *
 * 输入均为已解析的练习结果（ExerciseResult），不依赖 React / IPC，
 * 供 use-analytics 子 hook、AnalyticsPage、DashboardPage 复用。
 */

import { parseDbTimestamp } from "@/lib/db";
import { extractJsonSafe, matchAnswer } from "@/lib/parse-utils";
import { ExerciseResultSchema } from "@/lib/schemas";
import type { ExerciseQuestion, ExerciseResult } from "@/types";

// ============================================================================
// Constants — 掌握度判定规则
// ============================================================================

/** 判定"已掌握"所需的最少练习次数。 */
const MASTERY_MIN_ATTEMPTS = 2;

/** 判定"已掌握"所需的近期正确率下限（百分比）。 */
const MASTERY_ACCURACY_THRESHOLD = 80;

/** 计算近期正确率时取最近的练习次数窗口。 */
const MASTERY_RECENT_WINDOW = 3;

/** 已掌握类别在弱项推荐中的降权系数（权重减半）。 */
export const MASTERY_WEIGHT_FACTOR = 0.5;

// ============================================================================
// Types
// ============================================================================

/** 单次练习的轻量摘要（按类别聚合的输入单元）。 */
export interface ExerciseAttempt {
  /** 练习针对的错误类别 */
  category: string;
  /** 答对题数 */
  score: number;
  /** 题目总数 */
  total: number;
  /**
   * 练习时间（ISO / SQLite datetime 字符串）。**必填**：
   * "最近 N 次"窗口由该时间戳显式排序推导，与输入顺序无关。
   * 此前存在过"缺省时按输入序认定最新在前"的隐式约定（folklore contract），
   * 已废弃 —— 调用方一律从记录的 created_at 显式携带。
   */
  createdAt: string;
}

/** 某错误类别的掌握度统计。 */
export interface CategoryMastery {
  /** 类别名称 */
  name: string;
  /** 累计练习次数 */
  attempts: number;
  /** 全部练习的总体正确率（0-100 整数） */
  accuracy: number;
  /** 最近 MASTERY_RECENT_WINDOW 次练习的正确率（0-100 整数） */
  recentAccuracy: number;
  /** 是否达到掌握标准（练习次数与近期正确率均达标） */
  mastered: boolean;
}

/** 错题条目：题目 + 用户答案 + 溯源信息。 */
export interface WrongQuestion {
  /** 所属历史记录 ID（用于跳转详情） */
  historyId: number;
  /** 错误类别 */
  category: string;
  /** 练习时间 */
  createdAt: string;
  /** 题目内容 */
  question: ExerciseQuestion;
  /** 用户的错误答案 */
  userAnswer: string;
}

/** collectWrongQuestions 的输入单元（与 ParsedExercise 结构兼容）。 */
export interface ParsedExerciseEntry {
  record: { id: number; created_at: string };
  result: ExerciseResult;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * 按类别聚合练习记录，计算每个类别的掌握度。
 *
 * 掌握标准：练习次数 >= MASTERY_MIN_ATTEMPTS 且最近
 * MASTERY_RECENT_WINDOW 次的正确率 >= MASTERY_ACCURACY_THRESHOLD。
 *
 * @param attempts - 练习摘要列表。"最近 N 次"窗口按 createdAt 时间升序
 *   显式推导，与输入顺序无关（同刻时间戳按插入序保持稳定）
 * @returns 类别名 → 掌握度统计 的 Map
 */
export function computeCategoryMastery(attempts: ExerciseAttempt[]): Map<string, CategoryMastery> {
  const byCategory = new Map<string, ExerciseAttempt[]>();
  for (const a of attempts) {
    if (!a.category || a.total <= 0) continue;
    const list = byCategory.get(a.category);
    if (list) list.push(a);
    else byCategory.set(a.category, [a]);
  }

  const result = new Map<string, CategoryMastery>();
  for (const [name, list] of byCategory) {
    // 一律按 createdAt 时间升序排序后取"最近 N 次"——
    // 不再信任输入数组顺序隐含的新旧语义
    const sorted = [...list].sort(
      (a, b) => parseDbTimestamp(a.createdAt).getTime() - parseDbTimestamp(b.createdAt).getTime(),
    );

    const pct = (items: ExerciseAttempt[]) => {
      const totalQuestions = items.reduce((s, a) => s + a.total, 0);
      const correctQuestions = items.reduce((s, a) => s + a.score, 0);
      return totalQuestions > 0 ? Math.round((correctQuestions / totalQuestions) * 100) : 0;
    };

    const accuracy = pct(sorted);
    const recentAccuracy = pct(sorted.slice(-MASTERY_RECENT_WINDOW));
    const mastered =
      sorted.length >= MASTERY_MIN_ATTEMPTS && recentAccuracy >= MASTERY_ACCURACY_THRESHOLD;

    result.set(name, { name, attempts: sorted.length, accuracy, recentAccuracy, mastered });
  }
  return result;
}

/**
 * 统计纠错条目中的错误类别频次。
 *
 * useWritingAnalytics 类别分布、useRecentSessions 单条 topCategory 此前各自
 * 实现一份 Map 计数，统一收敛到此共享纯函数（Dashboard 弱项分析走
 * rankWeakCategories，内部经 computeWeakCategoryCounts 计数）。
 *
 * @param corrections - 纠错条目（只读取 category 字段；空 category 跳过）
 * @returns 类别 → 出现次数（无序，由调用方决定排序/取 top）
 */
export function countCorrectionCategories(
  corrections: Array<{ category: string }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of corrections) {
    if (!c.category) continue;
    map.set(c.category, (map.get(c.category) ?? 0) + 1);
  }
  return map;
}

/**
 * 从已配对的练习记录解析练习摘要（computeCategoryMastery 输入）。
 *
 * 输入来自 getHistoryWithResults 的 { records, resultById } 按 id 配对结果：
 * createdAt 从记录的 created_at 显式携带，掌握度的"最近 N 次"窗口
 * 完全由时间戳推导，与输入顺序无关。
 * 解析失败（结构异常的历史 JSON）或 result 缺失（空字符串）的条目跳过。
 *
 * @param entries - 已配对的 { createdAt, result } 列表
 */
export function parseExerciseAttempts(
  entries: Array<{ createdAt: string; result: string }>,
): ExerciseAttempt[] {
  return entries
    .map((e) => {
      // 结构异常的持久化 JSON 不能强转使用，必须经 Zod schema 校验
      const parsed = extractJsonSafe(e.result, ExerciseResultSchema);
      if (!parsed) return null;
      return {
        category: parsed.category,
        score: parsed.score,
        total: parsed.exercises.length,
        createdAt: e.createdAt,
      };
    })
    .filter((a): a is ExerciseAttempt => a !== null);
}

/**
 * 从写作批改的类别列表中统计弱项候选（最近 N 篇、按出现次数降序）。
 *
 * C2: Dashboard 与 use-analytics 此前各自实现一份"最近文章错误类别计数"，
 * 口径（窗口大小/排序）有漂移风险，统一收敛到此共享纯函数
 * （经 rankWeakCategories 供两侧弱项推荐共用）。
 *
 * @param categories - 已解析写作批改的类别列表（每个 corrections 元素一个 category，
 *   由调用方决定是否过滤空值）。约定按时间**降序**（最新在前）传入，
 *   函数取开头 window 篇作为"最近 N 篇"。
 * @param window - 只统计最近多少篇文章的类别（默认 10，与历史口径一致）
 * @returns 类别 → 出现次数，按次数降序
 */
export function computeWeakCategoryCounts(
  categories: string[][],
  window: number = 10,
): Array<{ name: string; count: number }> {
  if (categories.length === 0) return [];
  // 取"最近 N 篇"：调用方（use-writing-analytics）传入按时间**降序**（最新在前）的数组，
  // 取数组**开头** N 个即为最近 N 篇。勿用 slice(-window)（那会取到最旧的 N 篇）。
  const recent = categories.slice(0, window);
  const catMap = new Map<string, number>();
  for (const list of recent) {
    for (const c of list) {
      if (!c) continue;
      catMap.set(c, (catMap.get(c) ?? 0) + 1);
    }
  }
  return Array.from(catMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 对弱项类别计数应用掌握度降权：已掌握的类别权重减半。
 *
 * 用于弱项推荐排序 —— 用户已通过练习证明掌握的类别不再霸占推荐位，
 * 但仍保留（写作中反复出现说明可能回退），只是排序靠后。
 *
 * @param counts - 类别出现次数列表（如写作批改错误统计）
 * @param mastery - computeCategoryMastery 的输出
 * @returns 带降权后权重的列表，按权重降序
 */
export function applyMasteryWeight<T extends { name: string; count: number }>(
  counts: T[],
  mastery: Map<string, CategoryMastery>,
): (T & { weight: number; mastery: CategoryMastery | null })[] {
  return counts
    .map((c) => {
      const m = mastery.get(c.name) ?? null;
      const weight = m?.mastered ? c.count * MASTERY_WEIGHT_FACTOR : c.count;
      return { ...c, weight, mastery: m };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** rankWeakCategories 的输入 —— 两侧展示参数各自显式传入（无默认值）。 */
export interface WeakCategoryRankingOptions {
  /**
   * 每篇写作批改的错误类别列表（corrections 元素一个 category），
   * 按时间**降序**（最新在前）传入：函数取开头 window 篇作为"最近 N 篇"
   * （同 computeWeakCategoryCounts 的窗口约定，勿用最旧在前顺序）。
   */
  categoriesPerArticle: string[][];
  /** 练习摘要（computeCategoryMastery 输入；掌握度降权的证据，可为空数组） */
  exerciseAttempts: ExerciseAttempt[];
  /** 只统计最近多少篇文章的类别（Dashboard 20 / Analytics 编排层 10，刻意不同的展示口径） */
  window: number;
  /** 最多返回的弱项条数（Dashboard 1 / Analytics 编排层 2） */
  topN: number;
}

/**
 * 弱项推荐管线（计数 → 掌握度降权 → 截取 top N）的单一实现。
 *
 * 收敛此前 Dashboard（countCorrectionCategories → computeCategoryMastery →
 * applyMasteryWeight → top1）与 Analytics 编排层（computeWeakCategoryCounts →
 * applyMasteryWeight → top2）两套同意图接线 —— 参数差异（窗口/topN）是刻意的
 * 展示差异，管线本身共享，"最弱项"与"弱项训练推荐"不再可能两套口径。
 *
 * 排序与并列语义沿用既有两侧约定：计数降序（同次数按首现顺序稳定），
 * 降权后按权重降序（稳定排序，并列保持计数序）。
 *
 * @returns 排好序的前 topN 条弱项（count 为窗口内出现次数；mastery 为该类别
 *   的练习掌握度，未练习过为 null），无类别数据时为空数组
 */
export function rankWeakCategories({
  categoriesPerArticle,
  exerciseAttempts,
  window,
  topN,
}: WeakCategoryRankingOptions): Array<{
  name: string;
  count: number;
  weight: number;
  mastery: CategoryMastery | null;
}> {
  const counts = computeWeakCategoryCounts(categoriesPerArticle, window);
  const mastery = computeCategoryMastery(exerciseAttempts);
  return applyMasteryWeight(counts, mastery).slice(0, topN);
}

/**
 * 从已解析的练习记录中收集错题（按时间倒序，最新错题在前）。
 *
 * 使用与 ExercisePage 判分一致的 matchAnswer 逐题重判，
 * 保证错题判定口径与练习时完全相同。
 *
 * @param parsed - 已解析的练习记录（record + result）
 * @param limit - 最多返回的错题数（默认 50）
 * @returns 错题列表
 */
export function collectWrongQuestions(
  parsed: ParsedExerciseEntry[],
  limit: number = 50,
): WrongQuestion[] {
  const sorted = [...parsed].sort(
    (a, b) =>
      parseDbTimestamp(b.record.created_at).getTime() -
      parseDbTimestamp(a.record.created_at).getTime(),
  );

  const wrong: WrongQuestion[] = [];
  for (const p of sorted) {
    const { exercises, userAnswers, category } = p.result;
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      const userAnswer = userAnswers[i] ?? "";
      if (matchAnswer(userAnswer, ex.answer, ex.type)) continue;
      wrong.push({
        historyId: p.record.id,
        category,
        createdAt: p.record.created_at,
        question: ex,
        userAnswer,
      });
      if (wrong.length >= limit) return wrong;
    }
  }
  return wrong;
}
