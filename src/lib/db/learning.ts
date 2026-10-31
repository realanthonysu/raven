/**
 * 学习连续打卡与目标管理。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import { DailyActivitiesSchema } from "@/lib/schemas";
import type { GoalDto, ReviewStats, SidebarDataDto } from "./utils";
import { countStreak, getLocalDate } from "./utils";

/**
 * 学习活动类型 —— 与 Rust 端 `LearningActivity` 枚举（serde 小写形式）一一对应。
 * 收窄为字面量联合：传错字符串在编译期报错，而非运行时 IPC 才失败。
 */
export type LearningActivityType =
  | "writing"
  | "reading"
  | "exercise"
  | "listening"
  | "speaking"
  | "review";

/**
 * 记录一次学习活动（打卡）。
 *
 * 使用本地日期（YYYY-MM-DD），同一日期同一活动类型在 Rust 端自动累加计数。
 * 用于 Sidebar 学习目标进度和 AnalyticsPage 的统计分析。
 *
 * @param activity - 学习活动类型（writing / reading / exercise / listening / speaking / review）
 */
export async function recordLearningActivity(activity: LearningActivityType): Promise<void> {
  const date = getLocalDate();
  await invoke<void>("db_record_learning_activity", { date, activity });
  // 打卡成功 → 连胜/今日目标进度可能已变：立即失效共享聚合快照（D-07/S-05）
  invalidateLearningDataCache();
}

/**
 * 非关键副作用版本：记录学习活动失败时仅 warn，不抛出。
 *
 * R9: 统一 SpeakingPage/ListeningPage/ExercisePage/ReviewPage 中重复的
 * `recordLearningActivity(x).catch((e) => console.warn(...))` 样板。
 * 打卡统计是辅助功能，失败不应阻塞主流程或影响结果展示。
 */
export function recordLearningActivitySafe(activity: LearningActivityType): void {
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
 * 学习数据聚合快照的短 TTL（毫秒）。
 *
 * D-07/S-05：Sidebar、Dashboard、通知服务与 GoalsProvider 读取的是同一份
 * 「复习统计 + 连续天数 + 目标 + 今日活动」聚合。此前各自发起独立 IPC：
 * 冷启动时 review_stats 全表统计跑 2–3 次、streak 读 2 次、goals 查 2 次。
 * 现在统一经本模块的短 TTL 缓存（Promise 去重 + 5s TTL）：并发调用共享同一次
 * `db_get_sidebar_data`，数据一致且启动 IPC 数量下降。
 *
 * 失效策略：
 * - 写路径立即失效：`recordLearningActivity*`（打卡/连胜/今日活动）与
 *   `setLearningGoal`（目标）成功后调用 `invalidateLearningDataCache()`；
 * - 其余影响 review_stats 的词库写（加词/删词/改等级/复习评分）不在本模块，
 *   由 5s TTL 自然收敛——导航刷新与 2s 防抖之上最多再陈旧一个 TTL 窗口，
 *   对待复习徽章这类低时效数据可接受（ReviewPage 完成复习会打卡 → 立即失效）。
 */
export const LEARNING_DATA_CACHE_TTL_MS = 5_000;

/** Sidebar 聚合快照 —— getSidebarData 的返回形态 */
export interface SidebarData {
  reviewStats: ReviewStats;
  streak: number;
  goals: Record<string, number>;
  todayActivities: Record<string, number>;
}

/** 真实 IPC 取数（未缓存）——仅供下面的短 TTL 缓存 fetcher 使用 */
async function fetchSidebarData(): Promise<SidebarData> {
  const date = getLocalDate();
  const dto = await invoke<SidebarDataDto>("db_get_sidebar_data", { todayDate: date });
  const goals: Record<string, number> = {};
  for (const g of dto.goals) {
    goals[g.goal_type] = g.target;
  }
  let todayActivities: Record<string, number> = {};
  if (dto.today_activities) {
    // 此前裸 JSON.parse 后直接透传：脏数据（如 {"writing": "many"} 或嵌套结构）
    // 会原样流入 Sidebar 的进度计算。经 Zod 校验，不符时 fail-soft 退化为空对象，
    // 保证打卡展示不崩溃。
    try {
      const parsed = DailyActivitiesSchema.safeParse(JSON.parse(dto.today_activities));
      if (parsed.success) {
        todayActivities = parsed.data;
      } else {
        console.warn("[getSidebarData] invalid today_activities:", parsed.error.message);
      }
    } catch (e) {
      console.warn("[getSidebarData] failed to parse today_activities:", e);
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

/** 聚合快照缓存：并发去重 + 5s TTL（无 maxSize，单条目） */
const sidebarDataCache = createCachedFetcher(fetchSidebarData, {
  ttlMs: LEARNING_DATA_CACHE_TTL_MS,
});

/**
 * 使共享的学习数据聚合快照立即失效。
 *
 * 写路径（打卡/目标）成功后调用；测试在 beforeEach 中调用以隔离模块级缓存。
 * 词库写路径（words/review 模块）不在此处耦合：由 `LEARNING_DATA_CACHE_TTL_MS`
 * 自然过期，避免数据层模块间横向依赖。
 */
export function invalidateLearningDataCache(): void {
  sidebarDataCache.invalidate();
}

/**
 * L-10: 一次性获取 Sidebar 所需的全部数据（复习统计 + 连续天数 + 目标 + 今日活动）。
 * 合并 4 次 IPC 为 1 次，减少延迟和连接池竞争。
 *
 * D-07/S-05：本函数返回**短 TTL 缓存快照**（见 `LEARNING_DATA_CACHE_TTL_MS`），
 * Sidebar / Dashboard / 通知服务 / GoalsProvider 共享同一次 IPC 与同一份数据。
 * 需要绕过缓存的场景请先调用 `invalidateLearningDataCache()`。
 */
export async function getSidebarData(): Promise<SidebarData> {
  return sidebarDataCache.cached();
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
 * Rust 端校验 goal_type 白名单（review / exercise / reading / writing / listening / speaking），
 * 非法值会被拒绝。保存方（SettingsPage 的 GoalCard）成功后经 GoalsContext 的
 * refreshGoals() 刷新 Sidebar——不经 window event。
 *
 * @param goalType - 目标类型
 * @param target - 目标值（如每日复习 20 个单词）
 */
export async function setLearningGoal(
  goalType: "review" | "exercise" | "reading" | "writing" | "listening" | "speaking",
  target: number,
): Promise<void> {
  await invoke<void>("db_set_learning_goal", { goalType, target });
  // 目标保存成功 → 聚合快照（GoalsProvider/Sidebar 共享）立即失效
  invalidateLearningDataCache();
}
