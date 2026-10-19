/**
 * 单词工具函数 —— 生词本的 enrichment notes 构建和解析。
 *
 * 提供 notes 字段的格式化写入（buildEnrichmentNotes）和结构化解析（parseNotes），
 * 以及 WordLevel 枚举校验（isWordLevel）。
 */

import { WordLevelSchema } from "@/lib/schemas";
import type { EnrichedWord, Word, WordLevel } from "@/types";

/** 释义缺失时的占位文案（words 表 definition 列的约定值，enrichWord 失败时保留） */
export const PENDING_DEFINITION = "待补充";

/**
 * 判断单词是否需要 LLM 补全（释义为占位文案或音标缺失）。
 * VocabularyPage 的单个补全按钮与批量补全共用此判定。
 */
export function needsEnrichment(word: Pick<Word, "definition" | "phonetic">): boolean {
  return word.definition === PENDING_DEFINITION || !word.phonetic;
}

/**
 * 从 enrichWord 结果构建 updateWordEnrichment 的入参。
 * 单个补全、批量补全、CSV 导入补全三条路径共用，避免载荷结构漂移。
 *
 * level 透传 LLM 自动标注的词汇等级：nullish（LLM 未给出）时传 null，
 * Rust 侧 COALESCE 语义保留现有等级，不会覆盖用户手动标记的值。
 */
export function buildEnrichmentUpdate(enriched: EnrichedWord): {
  phonetic: string;
  definition: string;
  notes: string;
  level: WordLevel | null;
} {
  return {
    phonetic: enriched.phonetic || "",
    definition: enriched.definition || PENDING_DEFINITION,
    notes: buildEnrichmentNotes(enriched) || "",
    level: enriched.level ?? null,
  };
}

/**
 * 从 LLM 补全结果中构建 notes 字段（音标 + 释义 + 搭配 + 例句）。
 *
 * 返回格式示例：
 *   "音标: /wɜːrd/\n释义: 词；单词\n搭配: break the ice\n例句: He broke the ice at the party."
 *
 * 所有字段均为空时返回 null。
 *
 * @param enriched - enrichWord() 返回的结构化数据，或包含相同字段的 VocabEntry
 */
export function buildEnrichmentNotes(
  enriched: Pick<EnrichedWord, "definition" | "collocations" | "example"> & {
    phonetic: string | null;
  },
): string | null {
  return (
    [
      enriched.phonetic && `音标: ${enriched.phonetic}`,
      enriched.definition && `释义: ${enriched.definition}`,
      enriched.collocations && `搭配: ${enriched.collocations}`,
      enriched.example && `例句: ${enriched.example}`,
    ]
      .filter(Boolean)
      .join("\n") || null
  );
}

/**
 * 从单词 notes 字段中解析搭配和例句。
 *
 * 支持 `buildEnrichmentNotes` 写入的标准格式（`搭配: ...` / `例句: ...`），
 * 以及 LLM 生成的变体标签（`常见搭配` / `固定搭配` / `举例` 等）。
 * 冒号兼容全角 `：` 和半角 `:`。
 *
 * @param notes - 单词的 notes 字符串，可为 null
 * @returns 解析出的搭配和例句，未匹配时为 null
 */
export function parseNotes(notes: string | null): {
  collocations: string | null;
  example: string | null;
} {
  if (!notes) return { collocations: null, example: null };
  const collocationsMatch = notes.match(/(?:常见搭配|固定搭配|搭配)[：:]\s*(.+)/);
  const exampleMatch = notes.match(/(?:例句|举例)[：:]\s*(.+)/);
  return {
    collocations: collocationsMatch ? collocationsMatch[1].trim() : null,
    example: exampleMatch ? exampleMatch[1].trim() : null,
  };
}

/**
 * Runtime type guard：校验字符串是否为合法的 WordLevel。
 *
 * 使用 Zod enum schema 校验，替代手写 Set.has 守卫。
 * 用于处理 CSV 导入、表单输入等来自外部的不确定数据。
 * 无效值返回 false，调用方应提供默认值或拒绝。
 *
 * @example
 * ```ts
 * const level = isWordLevel(input) ? input : null;
 * ```
 */
export function isWordLevel(value: string): value is WordLevel {
  return WordLevelSchema.safeParse(value).success;
}
