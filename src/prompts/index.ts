/**
 * Prompt 模块统一导出 —— 集中管理各功能的系统提示词。
 *
 * 包含以下功能的提示词：
 * - correct: 写作纠错（CORRECT_PROMPT）
 * - exercise: 弱项练习题生成（buildExercisePrompt）
 * - listening: 听力句子与词汇提取（LISTENING_PROMPT、VOCAB_EXTRACTION_PROMPT）
 * - reading: 六维精读分析、语言检测、知识图谱（READING_PROMPT、DETECT_PROMPT 等）
 * - speaking: 口语跟读与评估（SPEAKING_PROMPT、EVALUATION_PROMPT）
 */
export { CORRECT_PROMPT } from "./correct";
export { buildExercisePrompt } from "./exercise";
export { LISTENING_PROMPT, VOCAB_EXTRACTION_PROMPT } from "./listening";
export { DETECT_PROMPT, GRAPH_DATA_PROMPT, GRAPH_SUMMARY_PROMPT, READING_PROMPT } from "./reading";
export { EVALUATION_PROMPT, SPEAKING_PROMPT } from "./speaking";
