/**
 * 听力练习提示词模块 —— 定义听力句子生成的 prompt。
 *
 * - LISTENING_PROMPT: 根据 CEFR 级别和主题生成 5 个英文听力句子（含中文提示）
 */

import { type LevelCode, levelPromptBlock } from "@/lib/levels";

/**
 * 构建听力句子生成的 prompt。
 *
 * 难度规格由 levelPromptBlock 注入（词汇范围/句长/语法/5 句递进指令，
 * 教学规格的单一事实来源在 lib/levels.ts），替代原 初级/中级/高级 三档描述。
 * 要求 LLM 生成 5 个英文句子，每个附带中文提示。
 * 输出严格 JSON 格式：{ sentences: [{ text, hint }] }
 */
export const LISTENING_PROMPT = (level: LevelCode, topic: string) =>
  `你是英语听力练习生成器。请生成 5 个英文听力句子。
${levelPromptBlock(level, "listening")}
主题：<topic>${topic}</topic>
每个句子附带一个中文提示（帮助理解语境）。

严格按以下 JSON 格式输出，不要输出其他内容：
{
  "sentences": [
    { "text": "英文句子", "hint": "中文提示" }
  ]
}`;
