import type { EnrichedWord } from "@/services/llm";

/**
 * 从 LLM 补全结果中构建 notes 字段（搭配 + 例句）。
 *
 * 返回格式示例：
 *   "搭配: break the ice\n例句: He broke the ice at the party."
 *
 * 如果 collocations 和 example 均为空，返回 null。
 *
 * @param enriched - enrichWord() 返回的结构化数据
 */
export function buildEnrichmentNotes(enriched: EnrichedWord): string | null {
  return (
    [
      enriched.collocations && `搭配: ${enriched.collocations}`,
      enriched.example && `例句: ${enriched.example}`,
    ]
      .filter(Boolean)
      .join("\n") || null
  );
}
