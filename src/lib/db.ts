/**
 * SQLite 数据库层 —— 所有持久化操作的唯一入口。
 *
 * 使用 `@tauri-apps/plugin-sql` 插件，底层通过 Tauri Rust 后端连接 SQLite。
 * 数据库文件为 `raven.db`，随 Tauri 应用数据目录存储。
 * 表结构由 `src-tauri/migrations/` 下的 SQL 文件定义。
 */
import Database from "@tauri-apps/plugin-sql";
import type { Word, ReviewStatus, HistoryRecord, ModelConfig, TTSConfig } from "@/types";

/** 单例 Promise，保证整个应用生命周期内只初始化一次数据库连接 */
let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:raven.db");
  }
  return dbPromise;
}

// --- 生词本 ---

/**
 * 添加生词到词汇本。
 *
 * `id` 和 `created_at` 由数据库自动生成，调用方不需要传入。
 * `review_status` 默认为 "new"，确保新词进入待复习队列。
 */
export async function addWord(word: Omit<Word, "id" | "created_at">) {
  const db = await getDb();
  return db.execute(
    "INSERT INTO words (word, phonetic, definition, level, source_type, source_text, notes, review_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [word.word, word.phonetic, word.definition, word.level, word.source_type, word.source_text, word.notes, word.review_status ?? "new"]
  );
}

export async function getWords(): Promise<Word[]> {
  const db = await getDb();
  return db.select<Word[]>("SELECT * FROM words ORDER BY created_at DESC");
}

export async function deleteWord(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM words WHERE id = $1", [id]);
}

export async function updateWordLevel(id: number, level: string) {
  const db = await getDb();
  return db.execute("UPDATE words SET level = $1 WHERE id = $2", [level, id]);
}

/**
 * 复习统计数据结构 —— 用于 ReviewPage 的仪表盘展示。
 * `dueCount` 表示"今天需要复习的词"，包含 new 状态和到期的 learning 状态。
 */
export interface ReviewStats {
  total: number;          // 生词本总词数
  newCount: number;       // 从未复习过的新词数
  learningCount: number;  // 正在学习中的词数
  masteredCount: number;  // 已掌握的词数
  dueCount: number;       // 今日待复习数（new + 到期的 learning）
}

/**
 * 获取复习统计 —— 单条 SQL 完成所有聚合，避免多次查询。
 *
 * due_count 的判定逻辑：new 状态的词 + next_review_at 为 NULL 或已到期的词。
 * 使用 SQLite 的 `datetime('now')` 进行时间比较，基于 UTC 时间。
 */
export async function getReviewStats(): Promise<ReviewStats> {
  const db = await getDb();
  const rows = await db.select<{ total: number; new_count: number; learning_count: number; mastered_count: number; due_count: number }[]>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN review_status = 'new' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN review_status = 'learning' THEN 1 ELSE 0 END) as learning_count,
      SUM(CASE WHEN review_status = 'mastered' THEN 1 ELSE 0 END) as mastered_count,
      SUM(CASE WHEN review_status = 'new' OR next_review_at IS NULL OR next_review_at <= datetime('now') THEN 1 ELSE 0 END) as due_count
    FROM words
  `);
  const r = rows[0];
  return {
    total: r.total,
    newCount: r.new_count,
    learningCount: r.learning_count,
    masteredCount: r.mastered_count,
    dueCount: r.due_count,
  };
}

/**
 * 获取待复习词汇列表。
 *
 * 排序策略：new 词优先（排序值 0），其次是按 next_review_at 升序（最早到期的优先）。
 * 默认限制 20 条，避免一次加载过多影响复习体验。
 * 排除 mastered 状态的词——已掌握的词不再进入复习队列。
 */
export async function getReviewWords(limit = 20): Promise<Word[]> {
  const db = await getDb();
  return db.select<Word[]>(`
    SELECT * FROM words
    WHERE review_status != 'mastered'
      AND (next_review_at IS NULL OR next_review_at <= datetime('now'))
    ORDER BY
      CASE WHEN review_status = 'new' THEN 0 ELSE 1 END,
      next_review_at ASC
    LIMIT $1
  `, [limit]);
}

/**
 * 更新词汇的复习状态。
 *
 * 由 ReviewPage 在用户选择"认识/模糊/不认识"后调用。
 * 间隔重复算法在 ReviewPage 中实现，此函数只负责持久化：
 * - "不认识"：重置间隔为 1 天
 * - "模糊"：保持当前间隔不变
 * - "认识"：间隔翻倍（上限 30 天），连续 3 次后晋升为 mastered
 */
export async function updateWordReview(
  id: number,
  status: ReviewStatus,
  reviewCount: number,
  nextReviewAt: string | null
) {
  const db = await getDb();
  return db.execute(
    "UPDATE words SET review_status = $1, review_count = $2, next_review_at = $3 WHERE id = $4",
    [status, reviewCount, nextReviewAt, id]
  );
}

// --- 历史记录 ---

/**
 * 保存历史记录。
 *
 * `graph_data` 为可选参数：Reading 类型的图谱数据通过单独的 LLM 调用获取，
 * 可能在主结果保存之后才写入，因此使用 `updateHistoryGraphData` 延迟更新。
 * Writing 类型不使用 graph_data，传 null 即可。
 */
export async function addHistory(record: Omit<HistoryRecord, "id" | "created_at" | "graph_data"> & { graph_data?: string | null }) {
  const db = await getDb();
  return db.execute(
    "INSERT INTO history (type, input_text, result, graph_data) VALUES ($1, $2, $3, $4)",
    [record.type, record.input_text, record.result, record.graph_data ?? null]
  );
}

export async function updateHistoryGraphData(id: number, graphData: string) {
  const db = await getDb();
  return db.execute(
    "UPDATE history SET graph_data = $1 WHERE id = $2",
    [graphData, id]
  );
}

export async function getHistory(type?: string): Promise<HistoryRecord[]> {
  const db = await getDb();
  if (type) {
    return db.select<HistoryRecord[]>(
      "SELECT * FROM history WHERE type = $1 ORDER BY created_at DESC",
      [type]
    );
  }
  return db.select<HistoryRecord[]>("SELECT * FROM history ORDER BY created_at DESC");
}

export async function getHistoryById(id: number): Promise<HistoryRecord | null> {
  const db = await getDb();
  const rows = await db.select<HistoryRecord[]>(
    "SELECT * FROM history WHERE id = $1 LIMIT 1",
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteHistory(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM history WHERE id = $1", [id]);
}

// --- 模型配置 ---

/**
 * 获取所有模型配置，按 is_default DESC 排序，默认模型排在最前。
 */
export async function getModels(): Promise<ModelConfig[]> {
  const db = await getDb();
  return db.select<ModelConfig[]>("SELECT * FROM models ORDER BY is_default DESC");
}

/**
 * 添加新模型配置。
 *
 * 先以 is_default=0 插入，再根据 model.is_default 决定是否设为默认。
 * 分两步是因为需要先获取 lastInsertId 才能调用 setDefaultModel。
 * setDefaultModel 使用 CASE WHEN 批量切换，保证"单一默认"语义。
 */
export async function addModel(model: Omit<ModelConfig, "id">) {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO models (name, api_key, base_url, model_name, is_default) VALUES ($1, $2, $3, $4, 0)",
    [model.name, model.api_key, model.base_url, model.model_name]
  );
  if (model.is_default) {
    const newId = (result as { lastInsertId?: number }).lastInsertId;
    if (newId) await setDefaultModel(newId);
  }
  return result;
}

export async function deleteModel(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM models WHERE id = $1", [id]);
}

/**
 * 获取默认模型，带回退逻辑。
 *
 * 优先返回 is_default=1 的模型；如果没有（比如用户删除了默认模型），
 * 则回退返回 id 最小的模型。返回 null 表示数据库中没有任何模型配置，
 * 调用方（SettingsPage）应提示用户先添加模型。
 */
export async function getDefaultModel(): Promise<ModelConfig | null> {
  const db = await getDb();
  const rows = await db.select<ModelConfig[]>(
    "SELECT * FROM models WHERE is_default = 1 LIMIT 1"
  );
  if (rows[0]) return rows[0];
  // 回退：如果没有默认模型，使用第一个
  const fallback = await db.select<ModelConfig[]>(
    "SELECT * FROM models ORDER BY id ASC LIMIT 1"
  );
  return fallback[0] ?? null;
}

/**
 * 设置默认模型 —— 单条 SQL 实现"单一选择"语义。
 *
 * CASE WHEN 保证同一时刻只有一个模型的 is_default=1，
 * 避免了"先全部置 0 再置 1"的竞态条件。
 */
export async function setDefaultModel(id: number) {
  const db = await getDb();
  await db.execute("UPDATE models SET is_default = CASE WHEN id = $1 THEN 1 ELSE 0 END", [id]);
}

// --- 设置 ---

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1 LIMIT 1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value]
  );
}

// --- TTS 配置 ---

export async function getTTSConfig(): Promise<TTSConfig> {
  const [baseUrl, apiKey, voice, speed] = await Promise.all([
    getSetting("tts_base_url"),
    getSetting("tts_api_key"),
    getSetting("tts_voice"),
    getSetting("tts_speed"),
  ]);
  return {
    base_url: baseUrl || "https://api.openai.com/v1",
    api_key: apiKey || "",
    voice: voice || "alloy",
    speed: speed ? parseFloat(speed) : 1.0,
  };
}

export async function setTTSSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
}
