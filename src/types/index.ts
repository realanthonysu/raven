/**
 * 类型定义模块 —— 集中管理应用的所有 TypeScript 接口和类型。
 *
 * 本文件包含两类类型定义：
 * 1. 直接定义的接口/类型：ModelConfig、Word、HistoryRecord、TTSConfig 等
 * 2. 从 @/lib/schemas 重导出的类型：CorrectionResult、ExerciseQuestion、ListeningResult 等
 *    （这些类型的 Zod schema 定义在 schemas.ts 中，此处仅做类型导出以便其他模块引用）
 */
import type { z } from "zod";

import type { WordLevel, WordSchema } from "@/lib/schemas";

export type { WordLevel };

/**
 * LLM 模型配置 —— 对应 SQLite `models` 表结构。
 *
 * 支持任意 OpenAI 兼容 API（如 DeepSeek、本地 Ollama 等），通过 `base_url` 区分。
 * `is_default` 采用"单选"语义：同一时刻只有一个模型为默认，
 * 由 `setDefaultModel()` 用 CASE WHEN 批量切换保证。
 *
 * `api_key` 的取值取决于来源命令（真实密钥存 OS Keychain，列表查询不下发）：
 * - `getDefaultModel()` / `getModelApiKey()` → 真实 Key
 *   （proxy.rs 豁免清单条目 1/3；前端以 `api_key` 非空作"已配置"判据，
 *   该判据仅对这两个来源成立）
 * - `getModels()` → 恒为空串（编辑表单按需经 `getModelApiKey()` 取真实 Key）
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
 * 复习状态（review_status 字段）的取值由 @/lib/schemas 的 ReviewStatusSchema 校验。
 */

/**
 * 生词本词条 —— 对应 SQLite `words` 表。
 *
 * 结构定义在 `WordSchema`（@/lib/schemas），此处由 z.infer 派生，
 * 保证类型与 ReviewPage 的 localStorage 会话运行时校验共用同一字段清单。
 *
 * 设计要点：
 * - `source_type` / `source_text` 记录词汇来源（如 "reading" + 原文片段），
 *   方便用户在复习时回溯上下文。
 * - `review_count` 和 `next_review_at` 驱动间隔重复算法：
 *   复习间隔由 Rust 端 FSRS 调度器计算并经 db_calculate_and_update_review 原子写回。
 * - 字段可选标记（?）是因为数据库升级时新增列可能为 null，
 *   以及 `addWord` 传入时不需要提供 `id` / `created_at`。
 */
export type Word = z.infer<typeof WordSchema>;

/**
 * 历史记录 —— 对应 SQLite `history` 表。
 *
 * `type` 区分记录来源功能：写作批改（"correct"/历史遗留别名 "writing"）、阅读分析
 * （"reading"）、练习（"exercise"）、听力（"listening"）、口语（"speaking"）。
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
  /**
   * 本次练习生成时使用的 CEFR 级别码（A2..C1，见 lib/levels.ts）。
   * 查询侧运行时恒有值（存量旧记录为 null）；类型上标记可选以兼容
   * 测试夹具的字面量构造，消费方读取时用 `?? null` 归一。
   */
  difficulty_level?: string | null;
  created_at: string;
}

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
  base_url: string; // TTS API 根路径，如 "https://api.xiaomimimo.com/v1"
  api_key: string; // API 密钥
  model: string; // TTS 模型标识，如 "mimo-v2.5-tts"、"tts-1"
  voice: string; // 音色标识，如 "冰糖"、"alloy"
  speed: number; // 语速，范围 0.25-4.0，默认 1.0
  /** TTS 协议方言：mimo（默认）| openai —— 决定 chat/completions 请求体形状 */
  dialect: string;
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
