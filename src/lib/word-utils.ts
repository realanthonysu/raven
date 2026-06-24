import type { EnrichedWord } from "@/services/llm";
import type { ReviewStatus, WordLevel } from "@/types";

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

/** 所有合法的词汇等级值，用于 runtime 校验 */
const VALID_WORD_LEVELS = new Set<WordLevel>(["CET-4", "CET-6", "TEM-4", "TEM-8"]);

/**
 * Runtime type guard：校验字符串是否为合法的 WordLevel。
 *
 * 替代 `as WordLevel` 不安全断言，用于处理 CSV 导入、表单输入等
 * 来自外部的不确定数据。无效值返回 false，调用方应提供默认值或拒绝。
 *
 * @example
 * ```ts
 * const level = isWordLevel(input) ? input : null;
 * ```
 */
export function isWordLevel(value: string): value is WordLevel {
  return VALID_WORD_LEVELS.has(value as WordLevel);
}

/** 所有合法的复习状态值，用于 runtime 校验 */
const VALID_REVIEW_STATUSES = new Set<ReviewStatus>(["new", "learning", "mastered"]);

/**
 * Runtime type guard：校验字符串是否为合法的 ReviewStatus。
 *
 * 替代 `as ReviewStatus` 不安全断言，用于处理 Rust/LLM 返回的不确定数据。
 * 无效值返回 false，调用方应提供降级处理。
 */
export function isReviewStatus(value: string): value is ReviewStatus {
  return VALID_REVIEW_STATUSES.has(value as ReviewStatus);
}
