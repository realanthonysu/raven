/**
 * 听力练习提示词模块 —— 定义听力句子生成和重点词汇提取的 prompt。
 *
 * 包含两个提示词：
 * - LISTENING_PROMPT: 根据难度和主题生成 5 个英文听力句子（含中文提示）
 * - VOCAB_EXTRACTION_PROMPT: 从听写错误的句子中提取值得学习的重点词汇
 */

/**
 * 构建听力句子生成的 prompt。
 * 要求 LLM 生成 5 个指定难度和主题的英文句子，每个附带中文提示。
 * 输出严格 JSON 格式：{ sentences: [{ text, hint }] }
 *
 * 难度规则：
 * - 初级：简单句，常用词汇，10 词以内
 * - 中级：复合句，中等词汇，15-20 词
 * - 高级：长难句，高级词汇，20 词以上
 * 5 个句子按难度递进排列。
 */
export const LISTENING_PROMPT = (difficulty: string, topic: string) =>
  `你是英语听力练习生成器。请生成 5 个${difficulty}难度的英文句子，主题为"${topic}"。
每个句子附带一个中文提示（帮助理解语境）。

严格按以下 JSON 格式输出，不要输出其他内容：
{
  "sentences": [
    { "text": "英文句子", "hint": "中文提示" }
  ]
}

要求：
- 初级：简单句，常用词汇，10 词以内
- 中级：复合句，中等词汇，15-20 词
- 高级：长难句，高级词汇，20 词以上
- 5 个句子难度递进
- hint 用中文简要说明句子场景或含义`;

/**
 * 构建重点词汇提取的 prompt。
 * 从用户听写错误的句子中提取 3-5 个值得学习的词汇。
 */
export const VOCAB_EXTRACTION_PROMPT = (wrongSentences: string) =>
  `从以下英文句子中提取 3-5 个值得学习的重点词汇（优先选择用户可能不认识的词）。

句子：
${wrongSentences}

严格按 JSON 格式输出：
{
  "words": [
    { "word": "vocabulary", "meaning": "中文释义" }
  ]
}
只输出 JSON，不要其他内容。`;
