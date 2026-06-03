/**
 * 数据访问层 —— 通过 Tauri Command 调用 Rust 端的数据库操作。
 *
 * 架构变更（v2）：
 * - 移除 @tauri-apps/plugin-sql，所有 SQL 操作在 Rust 端完成
 * - API Key 存储在 OS Keychain（Windows Credential Manager），不再经过 SQLite
 * - 前端通过 invoke() 调用 Rust Command，收窄 SQL 注入攻击面
 */
import { invoke } from "@tauri-apps/api/core";
import type { Word, ReviewStatus, HistoryRecord, ModelConfig, TTSConfig, CorrectionResult } from "@/types";
import { createCachedFetcher } from "./cache";
import { extractJson } from "./parse-utils";

// ============================================================================
// Rust 端 DTO 接口（与 commands.rs 中的结构体一一对应）
// ============================================================================

interface ReviewStatsDto {
  total: number;
  new_count: number;
  learning_count: number;
  mastered_count: number;
  due_count: number;
}

interface GoalDto {
  goal_type: string;
  target: number;
}

interface TtsConfigDto {
  base_url: string;
  api_key: string;
  voice: string;
  speed: number;
}

// ============================================================================
// 导出接口
// ============================================================================

export interface ReviewStats {
  total: number;
  newCount: number;
  learningCount: number;
  masteredCount: number;
  dueCount: number;
}

// ============================================================================
// 生词本
// ============================================================================

export async function addWord(word: Omit<Word, "id" | "created_at">) {
  return invoke<number>("db_add_word", {
    word: word.word,
    phonetic: word.phonetic,
    definition: word.definition,
    level: word.level,
    sourceType: word.source_type,
    sourceText: word.source_text,
    notes: word.notes,
    reviewStatus: word.review_status ?? "new",
  });
}

export async function getWords(): Promise<Word[]> {
  return invoke<Word[]>("db_get_words");
}

export async function deleteWord(id: number) {
  return invoke<void>("db_delete_word", { id });
}

export async function updateWordLevel(id: number, level: string) {
  return invoke<void>("db_update_word_level", { id, level });
}

export async function updateWordEnrichment(
  id: number,
  data: { phonetic: string; definition: string; notes: string }
) {
  return invoke<void>("db_update_word_enrichment", {
    id, ...data,
  });
}

export async function getReviewStats(): Promise<ReviewStats> {
  const dto = await invoke<ReviewStatsDto>("db_get_review_stats");
  return {
    total: dto.total,
    newCount: dto.new_count,
    learningCount: dto.learning_count,
    masteredCount: dto.mastered_count,
    dueCount: dto.due_count,
  };
}

export async function getReviewWords(limit = 20): Promise<Word[]> {
  return invoke<Word[]>("db_get_review_words", { limit });
}

export async function updateWordReview(
  id: number,
  status: ReviewStatus,
  reviewCount: number,
  nextReviewAt: string | null
) {
  return invoke<void>("db_update_word_review", {
    id, status, reviewCount, nextReviewAt,
  });
}

// ============================================================================
// 历史记录
// ============================================================================

export async function addHistory(record: Omit<HistoryRecord, "id" | "created_at" | "graph_data"> & { graph_data?: string | null }) {
  const lastInsertId = await invoke<number>("db_add_history", {
    recordType: record.type,
    inputText: record.input_text,
    result: record.result,
    graphData: record.graph_data ?? null,
  });
  return { lastInsertId };
}

export async function addHistorySafe(
  record: Parameters<typeof addHistory>[0],
  onError?: (msg: string) => void
): Promise<number | null> {
  try {
    const result = await addHistory(record);
    return result.lastInsertId ?? null;
  } catch (e) {
    const msg = `保存失败: ${e instanceof Error ? e.message : "未知错误"}`;
    console.warn(msg);
    onError?.(msg);
    return null;
  }
}

export async function updateHistoryGraphData(id: number, graphData: string) {
  return invoke<void>("db_update_history_graph_data", { id, graphData });
}

export async function getHistory(type?: string, limit?: number, offset?: number): Promise<HistoryRecord[]> {
  return invoke<HistoryRecord[]>("db_get_history", {
    recordType: type ?? null,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export async function getHistoryById(id: number): Promise<HistoryRecord | null> {
  return invoke<HistoryRecord | null>("db_get_history_by_id", { id });
}

export async function deleteHistory(id: number) {
  return invoke<void>("db_delete_history", { id });
}

/**
 * 构建个性化的用户学习上下文。
 * 查询最近的历史记录，提取高频错误类别和典型错误示例，
 * 用于注入 LLM prompt 以提升分析质量。
 */
export async function buildPersonalizedContext(maxRecords = 20): Promise<string> {
  try {
    const results = await invoke<string[]>("db_get_recent_correct_results", { maxRecords });

    if (results.length < 3) return "";

    const categoryMap = new Map<string, { count: number; examples: Array<{ original: string; corrected: string }> }>();

    for (const resultStr of results) {
      const parsed = extractJson<CorrectionResult>(resultStr);
      if (!parsed?.corrections) continue;

      for (const c of parsed.corrections) {
        if (!c.category) continue;
        const entry = categoryMap.get(c.category);
        if (entry) {
          entry.count++;
          if (entry.examples.length < 2) {
            entry.examples.push({ original: c.original, corrected: c.corrected });
          }
        } else {
          categoryMap.set(c.category, { count: 1, examples: [{ original: c.original, corrected: c.corrected }] });
        }
      }
    }

    if (categoryMap.size === 0) return "";

    const topCategories = [...categoryMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);

    const lines: string[] = [
      "用户近期学习背景（供参考，不要在回复中提及）：",
    ];

    const categorySummary = topCategories
      .map(([cat, data]) => `${cat}(${data.count}次)`)
      .join("、");
    lines.push(`- 高频错误类别：${categorySummary}`);

    const examples = topCategories
      .filter(([, data]) => data.examples.length > 0)
      .map(([cat, data]) => {
        const items = data.examples
          .map((ex) => `${ex.original} -> ${ex.corrected}`)
          .join("；");
        return `  · ${cat}：${items}`;
      });

    if (examples.length > 0) {
      lines.push("- 典型错误示例：");
      lines.push(...examples);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

// ============================================================================
// 模型配置（API Key 由 Rust 端自动存取到 OS Keychain）
// ============================================================================

export async function getModels(): Promise<ModelConfig[]> {
  return invoke<ModelConfig[]>("get_models");
}

export async function addModel(model: Omit<ModelConfig, "id">) {
  const lastInsertId = await invoke<number>("add_model", { model });
  return { lastInsertId };
}

export async function deleteModel(id: number) {
  return invoke<void>("delete_model", { id });
}

export async function getDefaultModel(): Promise<ModelConfig | null> {
  return invoke<ModelConfig | null>("get_default_model");
}

export async function setDefaultModel(id: number) {
  return invoke<void>("set_default_model", { id });
}

// ============================================================================
// 设置
// ============================================================================

export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("db_get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("db_set_setting", { key, value });
}

// ============================================================================
// 学习连续打卡
// ============================================================================

export async function recordLearningActivity(activity: string): Promise<void> {
  const date = new Date().toISOString().split("T")[0];
  return invoke<void>("db_record_learning_activity", { date, activity });
}

export async function getLearningStreak(): Promise<number> {
  const rows = await invoke<{ date: string; activities: string }[]>("db_get_all_streaks");
  if (rows.length === 0) return 0;

  let streak = 0;
  const today = new Date();
  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(today);
    expected.setDate(expected.getDate() - i);
    const expectedStr = expected.toISOString().split("T")[0];
    if (rows[i].date === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export async function getTodayActivities(): Promise<Record<string, number>> {
  const date = new Date().toISOString().split("T")[0];
  const activities = await invoke<string | null>("db_get_today_activities", { date });
  if (!activities) return {};
  try {
    return JSON.parse(activities);
  } catch {
    return {};
  }
}

// ============================================================================
// 学习目标
// ============================================================================

export async function getLearningGoals(): Promise<Record<string, number>> {
  const goals = await invoke<GoalDto[]>("db_get_learning_goals");
  const result: Record<string, number> = {};
  for (const g of goals) {
    result[g.goal_type] = g.target;
  }
  return result;
}

export async function setLearningGoal(goalType: string, target: number): Promise<void> {
  return invoke<void>("db_set_learning_goal", { goalType, target });
}

// ============================================================================
// TTS 配置（API Key 由 Rust 端自动存取到 OS Keychain）
// ============================================================================

export async function getTTSConfig(): Promise<TTSConfig> {
  const dto = await invoke<TtsConfigDto>("db_get_tts_config");
  return {
    base_url: dto.base_url,
    api_key: dto.api_key,
    voice: dto.voice,
    speed: dto.speed,
  };
}

const ttsConfigCache = createCachedFetcher(getTTSConfig);
export const getTTSConfigCached = ttsConfigCache.cached;
export const invalidateTTSConfigCache = (): void => ttsConfigCache.invalidate();

export async function setTTSSetting(key: string, value: string): Promise<void> {
  await invoke<void>("db_set_tts_setting", { key, value });
  invalidateTTSConfigCache();
}

// ============================================================================
// Phase 3: 间隔重复算法 + 导出 + 备份
// ============================================================================

interface ReviewCalcInput {
  review_status: string;
  review_count: number;
  next_review_at: string | null;
  rating: string;
}

interface ReviewCalcResult {
  status: string;
  interval: number;
  next_review_at: string;
}

/** 调用 Rust 端的间隔重复算法计算下次复习参数 */
export async function calculateNextReview(
  word: Pick<Word, "review_status" | "review_count" | "next_review_at">,
  rating: "again" | "hard" | "good"
): Promise<ReviewCalcResult> {
  return invoke<ReviewCalcResult>("calculate_next_review", {
    input: {
      review_status: word.review_status,
      review_count: word.review_count ?? 0,
      next_review_at: word.next_review_at ?? null,
      rating,
    } satisfies ReviewCalcInput,
  });
}

/** 导出所有生词为 CSV 格式字符串 */
export async function exportWordsCsv(): Promise<string> {
  return invoke<string>("export_words_csv");
}

/** 导出所有生词为 Anki 导入格式（Tab 分隔） */
export async function exportWordsAnki(): Promise<string> {
  return invoke<string>("export_words_anki");
}

/** 备份数据库文件到指定路径（使用 SQLite backup API） */
export async function backupDatabase(destPath: string): Promise<void> {
  return invoke<void>("backup_db", { destPath });
}
