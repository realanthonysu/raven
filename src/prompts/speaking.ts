/**
 * 口语练习提示词模块 —— 定义口语跟读和评估的系统提示词。
 *
 * 包含两个提示词：
 * - SPEAKING_PROMPT: 根据难度和主题生成 5 个适合跟读模仿的英文句子
 * - EVALUATION_PROMPT: 对用户的跟读结果进行多维度评估（发音、语法、流利度），
 *   并提供词级对齐分析（IPA 音标 + 发音状态标记）
 */

/**
 * 跟读模仿句子生成 prompt。
 * 要求 LLM 返回 JSON 格式，包含英文原句和中文翻译。
 */
export const SPEAKING_PROMPT = (difficulty: string, topic: string) =>
  `你是一个英语口语教练。请生成 5 个适合跟读模仿的英文句子。
难度：${difficulty}
主题：${topic}

要求：
- 句子长度适中（5-15 个单词），适合口语练习
- 使用地道自然的表达方式
- 提供准确的中文翻译
- 句子难度应递进

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "sentences": [
    {"text": "英文句子", "translation": "中文翻译"}
  ]
}`;

/**
 * 口语评估 prompt。
 * 将原句和用户实际说出的文本（ASR 转写）发给 LLM 评估。
 * 要求 LLM 返回词级对齐（wordAlignment）：原句每个词的 IPA 音标 + 发音状态。
 */
export const EVALUATION_PROMPT = (original: string, transcription: string) =>
  `你是一个英语口语评估专家。请评估以下跟读练习。

原句：${original}
用户实际说出：${transcription}

请从以下维度评估（每项 0-100 分）：
1. 发音准确度（pronunciation）：转写文本与原句的匹配程度
2. 语法正确性（grammar）：用户说出的内容语法是否正确
3. 流利度（fluency）：根据转写完整性判断

同时，请对原句的每个单词进行词级对齐分析，提供 IPA 音标和发音状态：
- correct：转写中正确匹配（含大小写差异）
- mispronounced：转写中有近似词但发音有误，或词形变化错误
- missed：转写中完全缺失（漏读）

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "pronunciation": 85,
  "grammar": 90,
  "fluency": 80,
  "overall": 85,
  "feedback": "简短的改进建议（1-2 句中文）",
  "wordAlignment": [
    {"word": "Hello", "ipa": "/həˈloʊ/", "status": "correct"},
    {"word": "world", "ipa": "/wɜːrld/", "status": "mispronounced"}
  ]
}`;
