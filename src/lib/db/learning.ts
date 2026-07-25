/**
 * 学习连续打卡与目标管理。
 */

import { invoke } from "@tauri-apps/api/core";
import type { GoalDto, ReviewStats, SidebarDataDto } from "./utils";
import { countStreak, getLocalDate } from "./utils";

/**
 * 记录一次学习活动（打卡）。
 *
 * 使用本地日期（YYYY-MM-DD），同一日期同一活动类型在 Rust 端自动累加计数。
 * 用于 Sidebar 学习目标进度和 AnalyticsPage 的统计分析。
 *
 * @param activity - 学习活动类型（writing / reading / exercise / listening / speaking / review）
 */
export async function recordLearningActivity(activity: string): Promise<void> {
  const date = getLocalDate();
  return invoke<void>("db_record_learning_activity", { date, activity });
}

/**
 * 非关键副作用版本：记录学习活动失败时仅 warn，不抛出。
 *
 * R9: 统一 SpeakingPage/ListeningPage/ExercisePage/ReviewPage 中重复的
 * `recordLearningActivity(x).catch((e) => console.warn(...))` 样板。
 * 打卡统计是辅助功能，失败不应阻塞主流程或影响结果展示。
 */
export function recordLearningActivitySafe(activity: string): void {
  recordLearningActivity(activity).catch((e) =>
    console.warn(`[${activity}] recordLearningActivity failed:`, e),
  );
}

/**
 * 计算连续学习天数。
 *
 * 从数据库查询所有打卡记录（按日期倒序），然后从今天开始向前遍历，
 * 遇到第一个缺失日期则停止计数。
 *
 * @param signal - 可选的 AbortSignal
 * @returns 连续学习天数（0 表示今天未学习或无任何打卡记录）
 */
export async function getLearningStreak(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const rows = await invoke<{ date: string; activities: string }[]>("db_get_all_streaks");
  return countStreak(rows, new Date());
}

/**
 * L-10: 一次性获取 Sidebar 所需的全部数据（复习统计 + 连续天数 + 目标 + 今日活动）。
 * 合并 4 次 IPC 为 1 次，减少延迟和连接池竞争。
 */
export async function getSidebarData(): Promise<{
  reviewStats: ReviewStats;
  streak: number;
  goals: Record<string, number>;
  todayActivities: Record<string, number>;
}> {
  const date = getLocalDate();
  const dto = await invoke<SidebarDataDto>("db_get_sidebar_data", { todayDate: date });
  const goals: Record<string, number> = {};
  for (const g of dto.goals) {
    goals[g.goal_type] = g.target;
  }
  let todayActivities: Record<string, number> = {};
  if (dto.today_activities) {
    try {
      todayActivities = JSON.parse(dto.today_activities);
    } catch {
      /* ignore */
    }
  }
  return {
    reviewStats: {
      total: dto.review_stats.total,
      newCount: dto.review_stats.new_count,
      learningCount: dto.review_stats.learning_count,
      masteredCount: dto.review_stats.mastered_count,
      dueCount: dto.review_stats.due_count,
    },
    streak: dto.streak,
    goals,
    todayActivities,
  };
}

/**
 * 查询所有学习目标。
 *
 * 返回目标类型 → 目标值的映射（如 `{ review: 20, exercise: 5 }`），
 * 用于 SettingsPage 的目标配置和 Sidebar 的进度展示。
 *
 * @returns 目标类型 → 目标值的映射
 */
export async function getLearningGoals(): Promise<Record<string, number>> {
  const goals = await invoke<GoalDto[]>("db_get_learning_goals");
  const result: Record<string, number> = {};
  for (const g of goals) {
    result[g.goal_type] = g.target;
  }
  return result;
}

/**
 * 设置/更新学习目标（Upsert 语义）。
 *
 * Rust 端校验 goal_type 白名单（review / exercise / reading / writing / listening），
 * 非法值会被拒绝。成功后触发 Sidebar 刷新（通过 window event）。
 *
 * @param goalType - 目标类型
 * @param target - 目标值（如每日复习 20 个单词）
 */
export async function setLearningGoal(goalType: string, target: number): Promise<void> {
  return invoke<void>("db_set_learning_goal", { goalType, target });
}
