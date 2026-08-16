/**
 * 练习统计纯函数模块 —— 弱项掌握度追踪、推荐降权与错题收集。
 *
 * 输入均为已解析的练习结果（ExerciseResult），不依赖 React / IPC，
 * 供 use-analytics 子 hook、AnalyticsPage、DashboardPage 复用。
 */

import { parseDbTimestamp } from "@/lib/db/utils";
import { matchAnswer } from "@/lib/parse-utils";
import type { ExerciseQuestion, ExerciseResult } from "@/types";

// ============================================================================
// Constants — 掌握度判定规则
// ============================================================================

/** 判定"已掌握"所需的最少练习次数。 */
export const MASTERY_MIN_ATTEMPTS = 2;

/** 判定"已掌握"所需的近期正确率下限（百分比）。 */
export const MASTERY_ACCURACY_THRESHOLD = 80;

/** 计算近期正确率时取最近的练习次数窗口。 */
export const MASTERY_RECENT_WINDOW = 3;

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
  /** 练习时间（ISO / SQLite datetime 字符串） */
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
 * @param attempts - 练习摘要列表（顺序不限，内部按时间排序）
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
    // 按时间升序，便于取"最近 N 次"
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
 * 从写作批改的类别列表中统计弱项候选（最近 N 篇、按出现次数降序）。
 *
 * C2: Dashboard 与 use-analytics 此前各自实现一份"最近文章错误类别计数"，
 * 口径（窗口大小/排序）有漂移风险，统一收敛到此共享纯函数。
 *
 * @param categories - 已解析写作批改的类别列表（每个 corrections 元素一个 category，
 *   由调用方决定是否过滤空值）
 * @param window - 只统计最近多少篇文章的类别（默认 10，与历史口径一致）
 * @returns 类别 → 出现次数，按次数降序
 */
export function computeWeakCategoryCounts(
  categories: string[][],
  window: number = 10,
): Array<{ name: string; count: number }> {
  if (categories.length === 0) return [];
  // 取"最近 N 篇":调用方负责按时间排序(升序或降序均可,此处取数组末尾 N 个——
  // use-writing-analytics 传入按时间**降序**(最新在前)的数组,slice(-window)
  // 会取到最旧 N 篇,因此这里改为取**开头** N 个并保持与调用方约定一致
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
