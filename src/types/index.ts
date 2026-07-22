/**
 * 类型定义模块 —— 集中管理应用的所有 TypeScript 接口和类型。
 *
 * 本文件包含两类类型定义：
 * 1. 直接定义的接口/类型：ModelConfig、Word、HistoryRecord、TTSConfig 等
 * 2. 从 @/lib/schemas 重导出的类型：Correction、ExerciseQuestion、ListeningResult 等
 *    （这些类型的 Zod schema 定义在 schemas.ts 中，此处仅做类型导出以便其他模块引用）
 */

/**
 * LLM 模型配置 —— 对应 SQLite `models` 表结构。
 *
 * 支持任意 OpenAI 兼容 API（如 DeepSeek、本地 Ollama 等），通过 `base_url` 区分。
 * `is_default` 采用"单选"语义：同一时刻只有一个模型为默认，
 * 由 `setDefaultModel()` 用 CASE WHEN 批量切换保证。
 */
export interface ModelConfig {
  id: number;
  name: string; // 用户自定义的模型别名，仅用于 UI 展示
  api_key: string;
  base_url: string; // API 根路径，不含 `/chat/completions` 后缀
  model_name: string; // 实际发送给 API 的 model 字段值，如 "deepseek-chat"
  is_default: boolean;
}

/**
 * 词汇等级标签 —— 对应中国英语考试体系。
 * CET-4/6 为大学英语四六级，TEM-4/8 为英语专业四八级。
 * 可为 null，表示用户未标记或 LLM 未识别出等级。
 */
import type { ReviewStatus, WordLevel } from "@/lib/schemas";

export type { ReviewStatus, WordLevel };

/**
 * 复习状态三态机：new → learning → mastered。
 * - new：首次加入生词本，尚未复习
 * - learning：进入过复习流程但尚未掌握
 * - mastered：连续 3 次"认识"后自动晋升
 */

/**
 * 生词本词条 —— 对应 SQLite `words` 表。
 *
 * 设计要点：
 * - `source_type` / `source_text` 记录词汇来源（如 "reading" + 原文片段），
 *   方便用户在复习时回溯上下文。
 * - `review_count` 和 `next_review_at` 驱动间隔重复算法：
 *   复习间隔由 ReviewPage 根据用户反馈动态计算并写回。
 * - 字段可选标记（?）是因为数据库升级时新增列可能为 null，
 *   以及 `addWord` 传入时不需要提供 `id` / `created_at`。
 */
export interface Word {
  id: number;
  word: string;
  phonetic: string | null; // 音标，LLM 不一定返回
  definition: string; // 释义，由 LLM 生成或用户手动填写
  level: WordLevel | null;
  source_type: string | null; // 来源类型，如 "reading"、"correct"
  source_text: string | null; // 原文上下文片段
  notes: string | null; // 用户自定义笔记
  review_status: ReviewStatus;
  review_count?: number; // 累计复习次数
  next_review_at?: string | null; // ISO 8601 时间戳，NULL 表示立即可复习
  created_at: string;
  // FSRS fields (migration 007) — optional for backward compat with pre-migration data
  stability?: number; // Memory stability in days
  difficulty?: number; // Card difficulty, 0-10 scale
  elapsed_days?: number; // Days elapsed since last review
  scheduled_days?: number; // Interval scheduled for this review
  reps?: number; // Total number of successful reviews
  lapses?: number; // Number of "again" ratings (forgetting events)
  state?: number; // FSRS state: 0=new, 1=learning, 2=review, 3=relearning
}

/**
 * 历史记录 —— 对应 SQLite `history` 表。
 *
 * `type` 区分写作批改（"correct"）和阅读分析（"reading"）两种功能。
 * `result` 存储 LLM 返回的原始文本（Writing 为 JSON 字符串，Reading 为 Markdown）。
 * `graph_data` 仅 Reading 类型使用，存储知识图谱的 JSON 数据，
 * 与 result 分开存储是因为图谱通过独立的 LLM 调用获取，
 * 可能在主结果之后才写入（见 `updateHistoryGraphData`）。
 */
export interface HistoryRecord {
  id: number;
  type: "correct" | "reading" | "exercise" | "listening" | "speaking" | "writing";
  input_text: string;
  result: string;
  graph_data: string | null; // JSON 字符串，存储 Cytoscape 图谱数据
  created_at: string;
}

/**
 * 单条纠错记录 —— 对应 LLM 返回的 JSON 中 corrections 数组的每个元素。
 * `category` 为错误分类标签（如 "语法"、"用词"、"拼写"），用于 AnalyticsPage 的统计分析。
 */
export type {
  CorrectionResult,
  EnrichedWord,
  ExerciseQuestion,
  ExerciseResult,
  ExerciseType,
  GraphData,
  LanguageDetection,
} from "@/lib/schemas";

/**
 * TTS 语音合成配置 —— 独立于 LLM 模型配置。
 *
 * 支持任意 OpenAI 兼容的 TTS API（如 OpenAI、Azure、本地服务）。
 * 配置存储在 settings 表中，以 tts_ 为前缀的 key-value 对。
 */
export interface TTSConfig {
  base_url: string; // TTS API 根路径，如 "https://api.openai.com/v1"
  api_key: string; // API 密钥
  model: string; // TTS 模型标识，如 "tts-1"、"mimo-v2.5-tts"
  voice: string; // 音色标识，如 "alloy"、"nova"
  speed: number; // 语速，范围 0.25-4.0，默认 1.0
}

/**
 * 听力/口语练习的结果类型 —— 持久化到 history 表。
 * 包含听力填空练习（ListeningResult）和口语跟读练习（SpeakingResult）的完整结果。
 */
export type {
  ListeningResult,
  ListeningSentence,
  SpeakingResult,
  SpeakingScore,
  SpeakingSentence,
  WordAlignmentItem,
} from "@/lib/schemas";
