/**
 * LLM 模型配置 —— 对应 SQLite `models` 表结构。
 *
 * 支持任意 OpenAI 兼容 API（如 DeepSeek、本地 Ollama 等），通过 `base_url` 区分。
 * `is_default` 采用"单选"语义：同一时刻只有一个模型为默认，
 * 由 `setDefaultModel()` 用 CASE WHEN 批量切换保证。
 */
export interface ModelConfig {
  id: number;
  name: string;         // 用户自定义的模型别名，仅用于 UI 展示
  api_key: string;
  base_url: string;     // API 根路径，不含 `/chat/completions` 后缀
  model_name: string;   // 实际发送给 API 的 model 字段值，如 "deepseek-chat"
  is_default: boolean;
}

/**
 * 词汇等级标签 —— 对应中国英语考试体系。
 * CET-4/6 为大学英语四六级，TEM-4/8 为英语专业四八级。
 * 可为 null，表示用户未标记或 LLM 未识别出等级。
 */
export type WordLevel = "CET-4" | "CET-6" | "TEM-4" | "TEM-8";

/**
 * 复习状态三态机：new → learning → mastered。
 * - new：首次加入生词本，尚未复习
 * - learning：进入过复习流程但尚未掌握
 * - mastered：连续 3 次"认识"后自动晋升
 */
export type ReviewStatus = "new" | "learning" | "mastered";

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
  phonetic: string | null;       // 音标，LLM 不一定返回
  definition: string;             // 释义，由 LLM 生成或用户手动填写
  level: WordLevel | null;
  source_type: string | null;     // 来源类型，如 "reading"、"correct"
  source_text: string | null;     // 原文上下文片段
  notes: string | null;           // 用户自定义笔记
  review_status: ReviewStatus;
  review_count?: number;          // 累计复习次数
  next_review_at?: string | null; // ISO 8601 时间戳，NULL 表示立即可复习
  created_at: string;
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
  type: "correct" | "reading";
  input_text: string;
  result: string;
  graph_data: string | null;  // JSON 字符串，存储 Cytoscape 图谱数据
  created_at: string;
}

/**
 * 单条纠错记录 —— 对应 LLM 返回的 JSON 中 corrections 数组的每个元素。
 * `category` 为错误分类标签（如 "语法"、"用词"、"拼写"），用于 AnalyticsPage 的统计分析。
 */
export interface Correction {
  original: string;     // 原文中的错误片段
  corrected: string;    // 修正后的文本
  category: string;     // 错误分类，用于 AnalyticsPage 聚合统计
  explanation: string;  // 中文解释，说明为什么是错误以及如何修正
}

/**
 * Writing Copilot（CorrectPage）的完整批改结果。
 * 由 LLM 以 JSON 格式返回，经 `parseCorrectionJson()` 解析后得到此结构。
 * `corrections` 数组驱动纠错详情列表，`summary` 用于总结卡片。
 */
export interface CorrectionResult {
  corrected_text: string;   // 完整的修正后文本
  corrections: Correction[];
  summary: string;          // 整体评价与建议
}
