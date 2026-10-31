/**
 * 生词本 CRUD 操作。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Word } from "@/types";

/** `getWordsPage` 的返回：当前页条目 + 同筛选条件总数。 */
export interface WordPage {
  items: Word[];
  total: number;
}

/** 生词等级 × 复习状态聚合行（`level = null` 表示未标记等级）。 */
export interface WordLevelStat {
  level: string | null;
  review_status: string;
  count: number;
}

/**
 * 批量添加单词的单条结果。
 *
 * - 成功插入：`id` 非空、`inserted = true`
 * - 已存在（含大小写变体）：`id` 为已有记录 id、`inserted = false`
 * - 单条失败：`id = null`、`error` 为错误信息
 */
export interface BatchWordResult {
  id: number | null;
  inserted: boolean;
  error: string | null;
}

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
 * 批量新增生词（整批在 Rust 侧单事务执行）。
 *
 * 逐条返回结果：已存在（含大小写变体）的条目不重复插入、`inserted = false`；
 * 单条校验失败（空词/超长/非法 level/review_status）只在该条 `error` 中报告，
 * 不影响同批其他条目。
 *
 * @param words - 生词数据数组（不含 id 和 created_at）
 * @returns 与输入等长的逐条结果
 */
export async function addWordsBatch(
  words: Omit<Word, "id" | "created_at">[],
): Promise<BatchWordResult[]> {
  return invoke<BatchWordResult[]>("db_add_words_batch", {
    inputs: words.map((word) => ({
      word: word.word,
      phonetic: word.phonetic,
      definition: word.definition,
      level: word.level,
      source_type: word.source_type,
      source_text: word.source_text,
      notes: word.notes,
      review_status: word.review_status ?? "new",
    })),
  });
}

/**
 * 查询生词列表（按创建时间倒序），支持分页与模糊搜索。
 *
 * 返回完整的 Word 对象，包含 FSRS 间隔重复字段（stability、difficulty 等）。
 * 用于 VocabularyPage 的生词列表展示。
 *
 * @param limit - 可选分页大小（不传返回全部；Rust 侧钳制到 1..=500，
 *   传更大值等效于 500）。队列刷新等窄用途应显式传 limit，避免为一次取数
 *   付全表 IPC 的代价；存在性检查请改用 {@link wordExists}
 * @param offset - 可选分页偏移
 * @param search - 可选搜索关键字（服务端按 word/definition/phonetic 匹配，
 *   不区分大小写。B2: 大词库搜索不再前端全量拉取后过滤）
 */
export async function getWords(limit?: number, offset?: number, search?: string): Promise<Word[]> {
  return invoke<Word[]>("db_get_words", {
    limit: limit ?? null,
    offset: offset ?? null,
    search: search?.trim() ? search.trim() : null,
  });
}

/**
 * 分页查询生词列表（按创建时间倒序），同时返回同筛选条件下的总数。
 *
 * 与 {@link getWords} 的区别：`limit` 必填（Rust 侧缺省 100、钳制 1..=500），
 * 返回值带 `total`，适合词汇页分页展示与分级统计，避免全量拉取整表。
 *
 * @param opts.limit - 每页条数（Rust 侧缺省 100、钳制到 1..=500）
 * @param opts.offset - 偏移量（缺省 0）
 * @param opts.search - 可选搜索关键字：服务端按 word/definition/phonetic 做不区分大小写包含匹配
 * @param opts.level - 可选等级精确筛选；`null`/不传表示不筛选
 */
export async function getWordsPage(opts: {
  limit: number;
  offset?: number;
  search?: string;
  level?: string | null;
}): Promise<WordPage> {
  return invoke<WordPage>("db_get_words_page", {
    limit: opts.limit,
    offset: opts.offset ?? null,
    search: opts.search?.trim() ? opts.search.trim() : null,
    level: opts.level ?? null,
  });
}

/**
 * 查询生词等级 × 复习状态聚合统计（`GROUP BY level, review_status`）。
 *
 * 用于词汇页的分级掌握度卡片；聚合在 Rust/SQLite 侧完成，不再拉取全量单词。
 */
export async function getWordStats(): Promise<WordLevelStat[]> {
  return invoke<WordLevelStat[]>("db_get_word_stats");
}

/**
 * 判断单词是否已存在于生词本（大小写不敏感精确匹配）。
 *
 * 加词路径的存在性预检专用：只需一个布尔值。此前用 `getWords(500, 0, word)`
 * 拉回一批完整 `WordDto` 再在前端逐条比对，既付出整行序列化/IPC 代价，又因
 * LIKE 模糊匹配需要额外精确比对才能判定；本函数走 Rust 侧 `lower(word)` 唯一
 * 索引等值查询，语义与 `db_add_word` 的幂等判定一致。
 *
 * @param word - 要检查的单词（前后空白会被裁掉；空词返回 `false`）
 * @returns 词库中是否已存在该词（大小写变体视为同一单词）
 */
export async function wordExists(word: string): Promise<boolean> {
  return invoke<boolean>("db_word_exists", { word: word.trim() });
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
 * `level` 提供时仅在现有等级为空（NULL 或空串）时回填 LLM 自动标注；
 * 已有等级（手动标记 / CSV 导入 / 先前的自动标注）永不被自动补全覆盖
 * （Rust 侧 CASE WHEN 空值回填语义）。
 *
 * @param id - 单词 ID
 * @param data - 补充信息对象：phonetic（音标）、definition（释义）、notes（笔记）、
 *   level（可选等级标签，取值见 WordLevelSchema）
 */
export async function updateWordEnrichment(
  id: number,
  data: { phonetic: string; definition: string; notes: string; level?: string | null },
) {
  return invoke<void>("db_update_word_enrichment", {
    id,
    phonetic: data.phonetic,
    definition: data.definition,
    notes: data.notes,
    level: data.level ?? null,
  });
}
