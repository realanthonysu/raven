/**
 * 数据访问层 —— 通过 Tauri Command 调用 Rust 端的数据库操作。
 *
 * 架构变更（v2）：
 * - 移除 @tauri-apps/plugin-sql，所有 SQL 操作在 Rust 端完成
 * - API Key 存储在 OS Keychain（Windows Credential Manager），不再经过 SQLite
 * - 前端通过 invoke() 调用 Rust Command，收窄 SQL 注入攻击面
 */
import { invoke } from "@tauri-apps/api/core";
import { getErrorMessage } from "@/lib/error-utils";
import type { HistoryRecord, ModelConfig, ReviewStatus, TTSConfig, Word } from "@/types";
import { createCachedFetcher } from "./cache";
import { extractJsonSafe } from "./parse-utils";
import { CorrectionResultSchema } from "./schemas";

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

/**
 * 新增一个生词到词汇本。
 *
 * 前端传入完整的 Word 字段（除 id 和 created_at 由后端自动生成），
 * Rust 端执行 INSERT INTO words 并返回新记录的 ID。
 *
 * @param word - 生词数据，不含 id 和 created_at
 * @returns 新插入记录的 ID
 */
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

/**
 * 查询所有生词列表（按创建时间倒序）。
 *
 * 返回完整的 Word 对象，包含 FSRS 间隔重复字段（stability、difficulty 等）。
 * 用于 VocabularyPage 的生词列表展示。
 *
 * @returns 生词数组
 */
export async function getWords(): Promise<Word[]> {
  return invoke<Word[]>("db_get_words");
}

/**
 * 删除指定生词。
 *
 * @param id - 要删除的单词 ID
 */
export async function deleteWord(id: number) {
  return invoke<void>("db_delete_word", { id });
}

/**
 * 更新单词的难度等级标签。
 *
 * 由 VocabularyPage 中用户手动触发，如标记为 "CET-4"、"CET-6" 等。
 *
 * @param id - 单词 ID
 * @param level - 新的难度等级标签
 */
export async function updateWordLevel(id: number, level: string) {
  return invoke<void>("db_update_word_level", { id, level });
}

/**
 * 更新单词的补充信息（音标、释义、笔记）。
 *
 * 通常在 LLM API 返回单词详情后调用（由 useAddToVocabulary hook 驱动）。
 *
 * @param id - 单词 ID
 * @param data - 补充信息对象：phonetic（音标）、definition（释义）、notes（笔记）
 */
export async function updateWordEnrichment(
  id: number,
  data: { phonetic: string; definition: string; notes: string },
) {
  return invoke<void>("db_update_word_enrichment", {
    id,
    ...data,
  });
}

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

// ============================================================================
// 历史记录
// ============================================================================

/**
 * 新增一条学习历史记录。
 *
 * 所有 LLM 页面（CorrectPage、ReadingPage、ExercisePage、ListeningPage、SpeakingPage）
 * 在完成任务后调用此函数持久化结果。
 *
 * @param record - 历史记录数据（不含 id、created_at，graph_data 可选）
 * @returns 包含 lastInsertId 的对象
 */
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

/**
 * 安全版本的历史记录写入 —— 失败时调用 onError 回调而非抛出异常。
 *
 * 用于页面组件中需要容错的场景（如 CorrectPage、ReadingPage），避免保存失败
 * 阻塞用户继续操作。
 *
 * @param record - 历史记录数据
 * @param onError - 可选的错误回调（显示 ErrorBanner 用）
 * @returns 写入成功返回 lastInsertId，失败返回 null
 */
export async function addHistorySafe(
  record: Parameters<typeof addHistory>[0],
  onError?: (msg: string) => void,
): Promise<number | null> {
  try {
    const result = await addHistory(record);
    return result.lastInsertId ?? null;
  } catch (e) {
    const msg = `保存失败: ${getErrorMessage(e)}`;
    console.warn(msg);
    onError?.(msg);
    return null;
  }
}

export async function updateHistoryGraphData(id: number, graphData: string) {
  return invoke<void>("db_update_history_graph_data", { id, graphData });
}

/**
 * 查询历史记录列表（含完整字段：id, type, input_text, result, graph_data, created_at）。
 *
 * 支持按记录类型过滤和分页。用于 AnalyticsPage 需要读取完整 result 字段时。
 * 如仅需列表视图（不含 result 和 graph_data），请使用 getHistoryList。
 *
 * @param types - 可选的记录类型过滤（单个字符串或数组）
 * @param limit - 可选的分页大小
 * @param offset - 可选的分页偏移
 * @param signal - 可选的 AbortSignal（用于取消请求）
 * @returns 历史记录数组
 */
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
      // H-4: 使用 Zod schema 进行运行时校验，避免 unvalidated cast 导致下游错误
      const parsed = extractJsonSafe(resultStr, CorrectionResultSchema);
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
  } catch (e) {
    console.warn("[db] buildPersonalizedContext failed:", e);
    return "";
  }
}

// ============================================================================
// 模型配置（API Key 由 Rust 端自动存取到 OS Keychain）
// ============================================================================

/**
 * 获取所有模型配置列表。
 *
 * @returns 模型配置数组
 */
export async function getModels(): Promise<ModelConfig[]> {
  return invoke<ModelConfig[]>("db_get_models");
}

/**
 * 新增模型配置。
 *
 * 在 Rust 端执行 DB 事务插入 + Keychain 写入。
 * 若设为默认模型，Rust 端会自动清除其他模型的默认标记。
 * 成功后失效默认模型缓存。
 *
 * @param model - 模型配置（不含 id）
 * @returns 包含 lastInsertId 的对象
 */
export async function addModel(model: Omit<ModelConfig, "id">) {
  const lastInsertId = await invoke<number>("db_add_model", { model });
  invalidateDefaultModelCache();
  return { lastInsertId };
}

/**
 * 删除指定模型配置。
 *
 * Rust 端同时清理 OS Keychain 中的 API Key。
 * 成功后失效默认模型缓存。
 *
 * @param id - 要删除的模型 ID
 */
export async function deleteModel(id: number) {
  await invoke<void>("db_delete_model", { id });
  invalidateDefaultModelCache();
}

export async function getDefaultModel(): Promise<ModelConfig | null> {
  return invoke<ModelConfig | null>("db_get_default_model");
}

const defaultModelCache = createCachedFetcher(getDefaultModel);
export const getDefaultModelCached = defaultModelCache.cached;
export const invalidateDefaultModelCache = (): void => defaultModelCache.invalidate();

/**
 * 设置指定模型为默认模型（清除其他模型的默认标记）。
 *
 * 成功后失效默认模型缓存，确保 LLM 请求使用新默认模型。
 *
 * @param id - 要设为默认的模型 ID
 */
export async function setDefaultModel(id: number) {
  await invoke<void>("db_set_default_model", { id });
  invalidateDefaultModelCache();
}

/**
 * 更新模型配置（名称、Base URL、模型名、API Key、默认状态）。
 *
 * Rust 端先执行 DB 事务更新，再写 Keychain。
 * 成功后失效默认模型缓存。
 *
 * @param id - 要更新的模型 ID
 * @param model - 更新后的模型配置
 */
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
  await invoke<void>("db_update_model", {
    id,
    name: model.name,
    baseUrl: model.base_url,
    modelName: model.model_name,
    apiKey: model.api_key,
    isDefault: model.is_default,
  });
  invalidateDefaultModelCache();
}

// ============================================================================
// 设置
// ============================================================================

/**
 * 查询单个设置项的值。
 *
 * @param key - 设置键名
 * @returns 设置值，不存在时返回 null
 */
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("db_get_setting", { key });
}

/**
 * 设置/更新一个键值对（Upsert 语义：存在则更新，不存在则插入）。
 *
 * @param key - 设置键名
 * @param value - 设置值
 */
export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("db_set_setting", { key, value });
}

// ============================================================================
// 学习连续打卡
// ============================================================================

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
 * 统一的练习结果持久化辅助函数 —— 封装 addHistorySafe + recordLearningActivitySafe。
 *
 * 消除 ExercisePage / ListeningPage / SpeakingPage 中手动组合两个调用的样板代码。
 * 两个操作独立执行：history 保存失败不阻塞 activity 记录，反之亦然。
 * 调用方可通过返回值检查哪步成功、哪步失败。
 *
 * @param recordType - 历史记录类型（exercise / listening / speaking）
 * @param inputText  - 用户输入文本（如主题描述）
 * @param result     - 练习结果 JSON 字符串
 * @param graphData  - 可选的知识图谱数据
 * @returns 两个操作的成败状态
 */
export async function savePracticeResult(
  recordType: HistoryRecord["type"],
  inputText: string,
  result: string,
  graphData?: string | null,
): Promise<{ historySaved: boolean; activityRecorded: boolean; historyError?: string }> {
  let historySaved = false;
  let activityRecorded = false;
  let historyError: string | undefined;

  try {
    await addHistory({ type: recordType, input_text: inputText, result, graph_data: graphData });
    historySaved = true;
  } catch (e) {
    historyError = getErrorMessage(e);
    const msg = `保存失败: ${historyError}`;
    console.warn(msg);
  }

  // M-9: 仅在历史记录保存成功时记录学习活动，避免 streak 统计与实际数据不一致
  if (historySaved) {
    try {
      await recordLearningActivity(recordType);
      activityRecorded = true;
    } catch (e) {
      console.warn(`[${recordType}] recordLearningActivity failed:`, e);
    }
  }

  return { historySaved, activityRecorded, historyError };
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

/**
 * 查询今日的学习活动统计。
 *
 * 返回今天的活动计数对象（如 `{ writing: 3, review: 5 }`），
 * 用于 Sidebar 的学习目标进度展示。
 *
 * @returns 活动类型 → 计数的映射，无记录时返回空对象
 */
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
// L-10: Sidebar 聚合数据
// ============================================================================

interface SidebarDataDto {
  review_stats: ReviewStatsDto;
  streak: number;
  goals: GoalDto[];
  today_activities: string | null;
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

// ============================================================================
// 学习目标
// ============================================================================

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
  rating: "again" | "hard" | "good" | "easy",
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

  return invoke<ReviewCalcResult>("db_calculate_next_review", {
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

/** 导出所有生词为 CSV 格式字符串 */
export async function exportWordsCsv(): Promise<string> {
  return invoke<string>("db_export_words_csv");
}

/** 导出所有生词为 Anki 导入格式（Tab 分隔） */
export async function exportWordsAnki(): Promise<string> {
  return invoke<string>("db_export_words_anki");
}

/** 写入文本内容到指定文件路径 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("db_write_text_file", { path, content });
}

/** 备份数据库文件到指定路径（使用 SQLite backup API） */
export async function backupDatabase(destPath: string): Promise<void> {
  return invoke<void>("db_backup_db", { destPath });
}
