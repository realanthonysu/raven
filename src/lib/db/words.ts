/**
 * 生词本 CRUD 操作。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Word } from "@/types";

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
 * 查询生词列表（按创建时间倒序），支持可选分页。
 *
 * 返回完整的 Word 对象，包含 FSRS 间隔重复字段（stability、difficulty 等）。
 * 用于 VocabularyPage 的生词列表展示。
 *
 * @param limit - 可选的最大返回条数（后端钳制到 1..=500），省略时返回全部
 * @param offset - 可选偏移量，仅在 limit 存在时生效
 * @returns 生词数组
 */
/**
 * 查询生词列表（按创建时间倒序），支持分页与模糊搜索。
 *
 * @param limit - 可选分页大小（不传返回全部；B2 起大词库推荐传分页参数）
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
