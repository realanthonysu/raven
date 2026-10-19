/**
 * 生词补全提示词模块 —— 定义词汇 enrichment 的 prompt。
 *
 * - ENRICHMENT_PROMPT: 根据英文单词生成音标、中文释义、常见搭配、例句与词汇等级
 */

/**
 * 构建生词补全的 prompt。
 * 要求 LLM 严格按 JSON 格式输出（不用 markdown 代码块包裹），
 * 输出结构：{ phonetic, definition, collocations, example, level }。
 * 消费方为 services/vocabulary-enrichment.ts（enrichWithModel），
 * 返回文本经 extractJsonSafe + EnrichedWordSchema 校验。
 *
 * level 的 11 个取值与 WordLevelSchema（src/lib/schemas.ts）的枚举一一对应：
 * 按该词在中国英语考试体系词汇表中的典型归属判断，跨档词取最低归属档，
 * 确实超出国内体系的词输出"超纲"。
 */
export const ENRICHMENT_PROMPT = (word: string) =>
  `请为以下英文单词提供详细信息。严格按 JSON 格式输出，不要用 markdown 代码块包裹：
{
  "phonetic": "音标（如 /wɜːrd/）",
  "definition": "中文释义（简洁准确）",
  "collocations": "常见搭配（2-3个，用逗号分隔）",
  "example": "一个地道的英文例句",
  "level": "词汇等级，按该词在中国英语考试体系词汇表中的典型归属判断，只能取以下之一：小学、中考、高考、CET-4、CET-6、考研、TEM-4、TEM-8、雅思、托福、超纲"
}
等级判断说明：
- 示例："apple"→"小学"，"negotiate"→"CET-4"，"ubiquitous"→"考研"或"超纲"
- 跨档词（同时属于多个词汇表）取最低归属档
- 确实超出国内英语考试体系的词输出"超纲"
单词：${word}`;
