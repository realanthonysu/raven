/**
 * SQLite 数据库层 —— 所有持久化操作的唯一入口。
 *
 * 使用 `@tauri-apps/plugin-sql` 插件，底层通过 Tauri Rust 后端连接 SQLite。
 * 数据库文件为 `raven.db`，随 Tauri 应用数据目录存储。
 * 表结构由 `src-tauri/migrations/` 下的 SQL 文件定义。
 */
import Database from "@tauri-apps/plugin-sql";
import type { Word, ReviewStatus, HistoryRecord, ModelConfig, TTSConfig, CorrectionResult } from "@/types";
import { createCachedFetcher } from "./cache";
import { extractJson } from "./parse-utils";

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

/** 获取所有生词，按创建时间倒序。 */
export async function getWords(): Promise<Word[]> {
  const db = await getDb();
  return db.select<Word[]>("SELECT * FROM words ORDER BY created_at DESC");
}

/** 删除指定 ID 的生词。 */
export async function deleteWord(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM words WHERE id = $1", [id]);
}

/** 更新生词的难度标签（CET-4/6、TEM-4/8）。 */
export async function updateWordLevel(id: number, level: string) {
  const db = await getDb();
  return db.execute("UPDATE words SET level = $1 WHERE id = $2", [level, id]);
}

/**
 * 更新生词的补全信息（音标、释义、笔记）。
 *
 * 由 VocabularyPage 的"补全"功能调用，在 LLM enrichment 成功后写入数据库。
 */
export async function updateWordEnrichment(
  id: number,
  data: { phonetic: string; definition: string; notes: string }
) {
  const db = await getDb();
  return db.execute(
    "UPDATE words SET phonetic = $1, definition = $2, notes = $3 WHERE id = $4",
    [data.phonetic, data.definition, data.notes, id]
  );
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

/**
 * 安全版 addHistory —— 捕获异常并返回 lastInsertId 或 null。
 *
 * 适合 fire-and-forget 场景（如 ReadingPage、ExercisePage），
 * 调用方可通过 onError 回调获取错误信息，而不需要 try/catch。
 */
export async function addHistorySafe(
  record: Parameters<typeof addHistory>[0],
  onError?: (msg: string) => void
): Promise<number | null> {
  try {
    const result = await addHistory(record);
    return (result as { lastInsertId?: number }).lastInsertId ?? null;
  } catch (e) {
    const msg = `保存失败: ${e instanceof Error ? e.message : "未知错误"}`;
    console.warn(msg);
    onError?.(msg);
    return null;
  }
}

/** 更新历史记录的知识图谱数据（由 ReadingPage 在图谱生成完成后调用）。 */
export async function updateHistoryGraphData(id: number, graphData: string) {
  const db = await getDb();
  return db.execute(
    "UPDATE history SET graph_data = $1 WHERE id = $2",
    [graphData, id]
  );
}

/** 获取历史记录列表，可按类型筛选，按创建时间倒序。 */
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

/** 根据 ID 获取单条历史记录，不存在时返回 null。 */
export async function getHistoryById(id: number): Promise<HistoryRecord | null> {
  const db = await getDb();
  const rows = await db.select<HistoryRecord[]>(
    "SELECT * FROM history WHERE id = $1 LIMIT 1",
    [id]
  );
  return rows[0] ?? null;
}

/** 删除指定 ID 的历史记录。 */
export async function deleteHistory(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM history WHERE id = $1", [id]);
}

/**
 * 构建个性化的用户学习上下文。
 * 查询最近的历史记录，提取高频错误类别和典型错误示例，
 * 用于注入 LLM prompt 以提升分析质量。
 *
 * @param maxRecords - 分析的历史记录数量（默认 20）
 * @returns 个性化上下文字符串，可直接追加到 prompt 末尾
 */
export async function buildPersonalizedContext(maxRecords = 20): Promise<string> {
  try {
    const db = await getDb();
    const recent = await db.select<HistoryRecord[]>(
      "SELECT * FROM history WHERE type = $1 ORDER BY created_at DESC LIMIT $2",
      ["correct", maxRecords]
    );

    // 新用户或数据不足时不做个性化
    if (recent.length < 3) return "";

    // 解析每条记录的纠错结果，提取 category 和示例
    const categoryMap = new Map<string, { count: number; examples: Array<{ original: string; corrected: string }> }>();

    for (const record of recent) {
      const parsed = extractJson<CorrectionResult>(record.result);
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

    // 取频率最高的前 3 个类别
    const topCategories = [...categoryMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);

    const lines: string[] = [
      "用户近期学习背景（供参考，不要在回复中提及）：",
    ];

    // 高频错误类别统计
    const categorySummary = topCategories
      .map(([cat, data]) => `${cat}(${data.count}次)`)
      .join("、");
    lines.push(`- 高频错误类别：${categorySummary}`);

    // 典型错误示例
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
    // 任何异常都不应阻塞主流程
    return "";
  }
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
  try {
    await db.execute("BEGIN");
    const result = await db.execute(
      "INSERT INTO models (name, api_key, base_url, model_name, is_default) VALUES ($1, $2, $3, $4, 0)",
      [model.name, model.api_key, model.base_url, model.model_name]
    );
    if (model.is_default) {
      const newId = (result as { lastInsertId?: number }).lastInsertId;
      if (newId) {
        await db.execute("UPDATE models SET is_default = CASE WHEN id = $1 THEN 1 ELSE 0 END", [newId]);
      }
    }
    await db.execute("COMMIT");
    return result;
  } catch (e) {
    await db.execute("ROLLBACK").catch(() => {});
    throw e;
  }
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

/** 获取设置值（key-value 存储），不存在时返回 null。 */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1 LIMIT 1",
    [key]
  );
  return rows[0]?.value ?? null;
}

/** 设置值（upsert 语义：存在则更新，不存在则插入）。 */
export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value]
  );
}

// --- 学习连续打卡 ---

/**
 * 记录今日学习活动（原子操作）。
 * 在用户完成任何学习操作后调用（写作批改、练习、复习等）。
 * 使用 SQLite JSON 函数实现原子递增，避免并发调用时的数据丢失。
 */
export async function recordLearningActivity(activity: string): Promise<void> {
  const db = await getDb();
  const today = new Date().toISOString().split("T")[0];
  await db.execute(`
    INSERT INTO learning_streaks (date, activities)
    VALUES ($1, json_set('{}', '$.' || $2, 1))
    ON CONFLICT(date) DO UPDATE SET activities = json_set(
      COALESCE(activities, '{}'),
      '$.' || $2,
      COALESCE(json_extract(activities, '$.' || $2), 0) + 1
    )
  `, [today, activity]);
}

/**
 * 获取当前连续学习天数。
 * 从今天开始向前回溯，连续有学习记录的天数。
 */
export async function getLearningStreak(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ date: string }[]>(
    "SELECT date FROM learning_streaks ORDER BY date DESC"
  );
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

/**
 * 获取今日学习统计。
 * 数据由 SQLite json_set() 原子写入，使用 JSON.parse 直接解析（非 LLM 输出，无需 extractJson 回退）。
 */
export async function getTodayActivities(): Promise<Record<string, number>> {
  const db = await getDb();
  const today = new Date().toISOString().split("T")[0];
  const rows = await db.select<{ activities: string }[]>(
    "SELECT activities FROM learning_streaks WHERE date = $1", [today]
  );
  if (!rows[0]) return {};
  try {
    return JSON.parse(rows[0].activities);
  } catch {
    return {};
  }
}

// --- 学习目标 ---

/**
 * 获取所有学习目标。
 * 返回 goal_type → target 的映射，如 `{ review: 10, exercise: 2 }`。
 * 未设置任何目标时返回空对象。
 */
export async function getLearningGoals(): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ goal_type: string; target: number }[]>(
    "SELECT * FROM learning_goals"
  );
  const goals: Record<string, number> = {};
  for (const row of rows) {
    goals[row.goal_type] = row.target;
  }
  return goals;
}

/**
 * 设置学习目标（upsert 语义）。
 * goal_type 为主键，已存在则更新 target，不存在则插入。
 *
 * @param goalType - 目标类型标识（如 "review"、"exercise"、"reading"、"writing"、"listening"）
 * @param target - 每日目标数量，非负整数
 */
export async function setLearningGoal(goalType: string, target: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO learning_goals (goal_type, target) VALUES ($1, $2) ON CONFLICT(goal_type) DO UPDATE SET target = $2",
    [goalType, target]
  );
}

// --- TTS 配置 ---

/** 获取 TTS 配置（非缓存版），返回 base_url、api_key、voice、speed。 */
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

// --- TTS 配置缓存 ---

/**
 * 带缓存的 TTS 配置获取。
 *
 * 首次调用走数据库查询并缓存结果；后续调用直接返回缓存。
 * 使用 Promise 去重：并发调用只触发一次查询，所有调用方共享同一 Promise。
 * 设置页面修改 TTS 配置后会自动失效缓存。
 */
const ttsConfigCache = createCachedFetcher(getTTSConfig);
export const getTTSConfigCached = ttsConfigCache.cached;
export const invalidateTTSConfigCache = (): void => ttsConfigCache.invalidate();

/** 设置 TTS 配置项并自动失效缓存。 */
export async function setTTSSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
  invalidateTTSConfigCache();
}
