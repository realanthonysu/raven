/**
 * 生词补全提示词模块 —— 定义词汇 enrichment 的 prompt。
 *
 * - ENRICHMENT_PROMPT: 根据英文单词生成音标、中文释义、常见搭配与例句
 */

/**
 * 构建生词补全的 prompt。
 * 要求 LLM 严格按 JSON 格式输出（不用 markdown 代码块包裹），
 * 输出结构：{ phonetic, definition, collocations, example }。
 * 消费方为 services/vocabulary-enrichment.ts（enrichWordUncached），
 * 返回文本经 extractJsonSafe + EnrichedWordSchema 校验。
 */
export const ENRICHMENT_PROMPT = (word: string) =>
  `请为以下英文单词提供详细信息。严格按 JSON 格式输出，不要用 markdown 代码块包裹：
{
  "phonetic": "音标（如 /wɜːrd/）",
  "definition": "中文释义（简洁准确）",
  "collocations": "常见搭配（2-3个，用逗号分隔）",
  "example": "一个地道的英文例句"
}
单词：${word}`;
