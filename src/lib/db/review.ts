/**
 * 复习统计与 FSRS 间隔重复操作。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Word } from "@/types";
import type { FsrsCard, ReviewCalcResult, ReviewStats, ReviewStatsDto } from "./utils";

/**
 * 查询复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
 *
 * Sidebar 和 ReviewPage 使用此数据驱动 UI 显示（待复习角标等）。
 * `signal` 参数支持中止请求（如组件卸载时清理）。
 *
 * @param signal - 可选的 AbortSignal
 * @returns 复习统计数据对象
 */
export async function getReviewStats(signal?: AbortSignal): Promise<ReviewStats> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const dto = await invoke<ReviewStatsDto>("db_get_review_stats");
  return {
    total: dto.total,
    newCount: dto.new_count,
    learningCount: dto.learning_count,
    masteredCount: dto.mastered_count,
    dueCount: dto.due_count,
  };
}

/**
 * 查询待复习单词列表（未掌握且已到期的单词优先）。
 *
 * 排序规则：新词优先，其次按 next_review_at 升序（最早到期的排最前）。
 * ReviewPage 使用此接口获取本次复习的单词队列。
 *
 * @param limit - 最大返回条数，默认 20
 * @returns 待复习单词数组
 */
export async function getReviewWords(limit = 20): Promise<Word[]> {
  return invoke<Word[]>("db_get_review_words", { limit });
}

/**
 * 原子操作：计算 FSRS 下次复习参数并立即更新数据库（H-3 修复）。
 *
 * 将 calculateNextReview 和 updateWordReviewFsrs 合并为单一 IPC 调用，
 * 消除两步操作之间的崩溃窗口和部分成功状态不一致问题。
 *
 * @param id - 单词 ID
 * @param card - 当前 FSRS 卡片状态
 * @param rating - 用户评分
 * @returns FSRS 调度结果
 */
export async function calculateAndUpdateReview(
  id: number,
  card: FsrsCard,
  rating: "again" | "hard" | "good" | "easy",
): Promise<ReviewCalcResult> {
  return invoke<ReviewCalcResult>("db_calculate_and_update_review", { id, card, rating });
}
