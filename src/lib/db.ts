/**
 * 数据访问层 —— 通过 Tauri Command 调用 Rust 端的数据库操作。
 *
 * 架构变更（v2）：
 * - 移除 @tauri-apps/plugin-sql，所有 SQL 操作在 Rust 端完成
 * - API Key 存储在 OS Keychain（Windows Credential Manager），不再经过 SQLite
 * - 前端通过 invoke() 调用 Rust Command，收窄 SQL 注入攻击面
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  CorrectionResult,
  HistoryRecord,
  ModelConfig,
  ReviewStatus,
  TTSConfig,
  Word,
} from "@/types";
import { createCachedFetcher } from "./cache";
import { extractJson } from "./parse-utils";

/**
 * 获取本地日期字符串（YYYY-MM-DD 格式）。
 * 使用本地时区而非 UTC，避免跨时区日期不一致问题
 * （例如 UTC+8 凌晨时 toISOString() 仍返回昨天的日期）。
 */
function getLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
  model: string;
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
    input: {
      word: word.word,
      phonetic: word.phonetic,
      definition: word.definition,
      level: word.level,
      source_type: word.source_type,
      source_text: word.source_text,
      notes: word.notes,
      review_status: word.review_status ?? "new",
    },
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
  data: { phonetic: string; definition: string; notes: string },
) {
  return invoke<void>("db_update_word_enrichment", {
    id,
    ...data,
  });
}

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

export async function getReviewWords(limit = 20): Promise<Word[]> {
  return invoke<Word[]>("db_get_review_words", { limit });
}

export async function updateWordReview(
  id: number,
  status: ReviewStatus,
  reviewCount: number,
  nextReviewAt: string | null,
) {
  return invoke<void>("db_update_word_review", {
    id,
    status,
    reviewCount,
    nextReviewAt,
  });
}

// ============================================================================
// 历史记录
// ============================================================================

export async function addHistory(
  record: Omit<HistoryRecord, "id" | "created_at" | "graph_data"> & { graph_data?: string | null },
) {
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
  onError?: (msg: string) => void,
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

export async function getHistory(
  types?: string | string[],
  limit?: number,
  offset?: number,
  signal?: AbortSignal,
): Promise<HistoryRecord[]> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const recordTypes = types ? (Array.isArray(types) ? types : [types]) : null;
  return invoke<HistoryRecord[]>("db_get_history", {
    recordTypes,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

/**
 * Lightweight history list query — excludes the heavy `result` and `graph_data` columns.
 * Use this for the list view where only id, type, input_text, and created_at are needed.
 */
export async function getHistoryList(
  types?: string | string[],
  limit?: number,
  offset?: number,
): Promise<HistoryRecord[]> {
  const recordTypes = types ? (Array.isArray(types) ? types : [types]) : null;
  return invoke<HistoryRecord[]>("db_get_history_list", {
    recordTypes,
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

    const categoryMap = new Map<
      string,
      { count: number; examples: Array<{ original: string; corrected: string }> }
    >();

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
          categoryMap.set(c.category, {
            count: 1,
            examples: [{ original: c.original, corrected: c.corrected }],
          });
        }
      }
    }

    if (categoryMap.size === 0) return "";

    const topCategories = [...categoryMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);

    const lines: string[] = ["用户近期学习背景（供参考，不要在回复中提及）："];

    const categorySummary = topCategories
      .map(([cat, data]) => `${cat}(${data.count}次)`)
      .join("、");
    lines.push(`- 高频错误类别：${categorySummary}`);

    const examples = topCategories
      .filter(([, data]) => data.examples.length > 0)
      .map(([cat, data]) => {
        const items = data.examples.map((ex) => `${ex.original} -> ${ex.corrected}`).join("；");
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

/// P2-3: 单独获取模型 API Key（列表接口不再返回密钥）
export async function getModelApiKey(id: number): Promise<string> {
  return invoke<string>("get_model_api_key", { id });
}

export async function addModel(model: Omit<ModelConfig, "id">) {
  const lastInsertId = await invoke<number>("add_model", { model });
  invalidateDefaultModelCache();
  return { lastInsertId };
}

export async function deleteModel(id: number) {
  await invoke<void>("delete_model", { id });
  invalidateDefaultModelCache();
}

export async function getDefaultModel(): Promise<ModelConfig | null> {
  return invoke<ModelConfig | null>("get_default_model");
}

const defaultModelCache = createCachedFetcher(getDefaultModel);
export const getDefaultModelCached = defaultModelCache.cached;
export const invalidateDefaultModelCache = (): void => defaultModelCache.invalidate();

export async function setDefaultModel(id: number) {
  await invoke<void>("set_default_model", { id });
  invalidateDefaultModelCache();
}

export async function updateModel(
  id: number,
  model: {
    name: string;
    base_url: string;
    model_name: string;
    api_key: string;
    is_default: boolean;
  },
) {
  await invoke<void>("update_model", { id, ...model });
  invalidateDefaultModelCache();
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

export async function getLearningStreak(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const rows = await invoke<{ date: string; activities: string }[]>("db_get_all_streaks");
  if (rows.length === 0) return 0;

  let streak = 0;
  const today = new Date();
  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(today);
    expected.setDate(expected.getDate() - i);
    const expectedStr = getLocalDate(expected);
    if (rows[i].date === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export async function getTodayActivities(): Promise<Record<string, number>> {
  const date = getLocalDate();
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
    model: dto.model,
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

/** 写入单个 TTS 设置但不立即失效缓存（供批量操作使用） */
async function setTTSSettingNoInvalidate(key: string, value: string): Promise<void> {
  await invoke<void>("db_set_tts_setting", { key, value });
}

/** 批量写入多个 TTS 设置，全部成功后统一失效缓存一次 */
export async function setTTSSettingBatch(entries: Array<[string, string]>): Promise<void> {
  await Promise.all(entries.map(([key, value]) => setTTSSettingNoInvalidate(key, value)));
  invalidateTTSConfigCache();
}

// ============================================================================
// ASR 配置（复用 TTS 的 base_url 和 api_key，仅模型名不同）
// ============================================================================

export async function getASRModel(): Promise<string> {
  return (await getSetting("asr_model")) || "mimo-v2.5-asr";
}

export async function setASRModel(model: string): Promise<void> {
  await setSetting("asr_model", model);
}

// ============================================================================
// Phase 3: 间隔重复算法 (FSRS) + 导出 + 备份
// ============================================================================

/** FSRS card state — sent to Rust for calculation, returned with updates. */
export interface FsrsCard {
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number; // 0=new, 1=learning, 2=review, 3=relearning
}

interface ReviewCalcResult {
  status: string;
  interval: number;
  next_review_at: string;
  card: FsrsCard;
}

/** 调用 Rust 端的 FSRS 间隔重复算法计算下次复习参数。
 *  Passes the current FSRS card state + user rating; returns updated state + next review date.
 *  For legacy cards without FSRS data, defaults are used (stability=0 signals "new" to FSRS).
 *
 *  elapsed_days 计算（BUG-01 修复）：
 *  数据库中存储的 elapsed_days 在每次 review 后被重置为 0，因此需要从
 *  next_review_at 和 scheduled_days 反推上次复习日期，计算真实的天数差。
 *  公式：last_review_date ≈ next_review_at - scheduled_days
 *        actual_elapsed  = now - last_review_date
 */
export async function calculateNextReview(
  word: Pick<
    Word,
    | "stability"
    | "difficulty"
    | "elapsed_days"
    | "scheduled_days"
    | "reps"
    | "lapses"
    | "state"
    | "next_review_at"
  >,
  rating: "again" | "hard" | "good",
): Promise<ReviewCalcResult> {
  // 计算真实 elapsed_days：从 next_review_at 和 scheduled_days 反推上次复习日期
  let actualElapsedDays = word.elapsed_days ?? 0;
  if (word.next_review_at && word.scheduled_days && word.scheduled_days > 0) {
    const nextReviewDate = new Date(word.next_review_at).getTime();
    // 上次复习日期 ≈ next_review_at 减去当时设定的间隔天数
    const lastReviewDate = nextReviewDate - word.scheduled_days * 24 * 60 * 60 * 1000;
    const computed = Math.max(0, Math.round((Date.now() - lastReviewDate) / (24 * 60 * 60 * 1000)));
    if (computed > 0) actualElapsedDays = computed;
  }

  return invoke<ReviewCalcResult>("calculate_next_review", {
    input: {
      card: {
        stability: word.stability ?? 0,
        difficulty: word.difficulty ?? 0,
        elapsed_days: actualElapsedDays,
        scheduled_days: word.scheduled_days ?? 0,
        reps: word.reps ?? 0,
        lapses: word.lapses ?? 0,
        state: word.state ?? 0,
      } satisfies FsrsCard,
      rating,
    },
  });
}

/** 更新单词的复习状态，包括 FSRS 参数。
 *  替代旧的 updateWordReview，在 ReviewPage 中与 FSRS 算法配合使用。
 *  P3-8: 入参重构为对象，与 Rust 端 FsrsReviewUpdate struct 对应。 */
export async function updateWordReviewFsrs(
  id: number,
  status: ReviewStatus,
  reviewCount: number,
  nextReviewAt: string | null,
  card: FsrsCard,
) {
  return invoke<void>("db_update_word_review_fsrs", {
    input: {
      id,
      status,
      review_count: reviewCount,
      next_review_at: nextReviewAt,
      card,
    },
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

/** 写入文本内容到指定文件路径 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

/** 备份数据库文件到指定路径（使用 SQLite backup API） */
export async function backupDatabase(destPath: string): Promise<void> {
  return invoke<void>("backup_db", { destPath });
}
