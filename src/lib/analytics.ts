/**
 * Analytics 模块的常量、类型和辅助函数。
 *
 * 从 AnalyticsPage.tsx 中抽取，供 useAnalytics hook 和 AnalyticsPage 共用。
 */
import type { HistoryRecord, CorrectionResult, ExerciseResult, ListeningResult } from "@/types";
import { extractJson } from "@/lib/parse-utils";

// ==================== 常量 ====================

/** 各错误类别的固定颜色映射，确保柱状图和饼图中同一类别颜色一致 */
export const CATEGORY_COLORS: Record<string, string> = {
  "主谓一致": "#3b82f6",
  "冠词错误": "#8b5cf6",
  "单复数": "#06b6d4",
  "用词不当": "#f59e0b",
  "时态错误": "#ef4444",
  "拼写错误": "#10b981",
  "介词错误": "#ec4899",
  "句式杂糅": "#6366f1",
  "标点错误": "#14b8a6",
  "缺少成分": "#f97316",
  "语序错误": "#a855f7",
};

/** 饼图的备用颜色（当类别不在 CATEGORY_COLORS 中时使用） */
export const PIE_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444",
  "#10b981", "#ec4899", "#6366f1", "#14b8a6", "#f97316", "#a855f7",
];

/**
 * 错误类别 → 能力维度映射。
 * 将 11 个错误类别归纳为 4 个非重叠的能力维度。
 */
export const DIMENSION_MAP: Record<string, string> = {
  "时态错误": "语法",
  "主谓一致": "语法",
  "介词错误": "语法",
  "用词不当": "词汇",
  "拼写错误": "词汇",
  "句式杂糅": "句式",
  "缺少成分": "句式",
  "语序错误": "句式",
  "冠词错误": "细节",
  "单复数": "细节",
  "标点错误": "细节",
};

/** 4 个能力维度的固定展示顺序和颜色 */
export const DIMENSION_CONFIG: { name: string; color: string }[] = [
  { name: "语法", color: "#3b82f6" },
  { name: "词汇", color: "#f59e0b" },
  { name: "句式", color: "#10b981" },
  { name: "细节", color: "#8b5cf6" },
];

// ==================== 类型 ====================

/** 错误类型分布的统计数据 */
export interface CategoryStat {
  name: string;
  count: number;
}

/** 趋势图中的单个数据点 */
export interface TrendPoint {
  date: string;
  errors: number;
  index: number;
}

/** 成绩趋势图中的单个数据点 */
export interface ScoreTrendPoint {
  date: string;
  scorePercent: number;
  label: string;
}

/** 近期会话详情列表的单条记录 */
export interface SessionDetail {
  id: number;
  date: string;
  textPreview: string;
  type: HistoryRecord["type"];
  score?: number;
  total?: number;
  topCategory?: string;
}

/**
 * 能力维度数据点。
 */
export interface CapabilityPoint {
  dimension: string;
  score: number;
  trend: "improving" | "declining" | "stable" | "none";
  color: string;
}

// ==================== 校验函数 ====================

/** ExerciseResult 校验函数 */
export function isExerciseResult(data: unknown): data is ExerciseResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.category === "string" &&
    Array.isArray(obj.exercises) &&
    Array.isArray(obj.userAnswers) &&
    typeof obj.score === "number"
  );
}

/** ListeningResult 校验函数 */
export function isListeningResult(data: unknown): data is ListeningResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.difficulty === "string" &&
    typeof obj.topic === "string" &&
    Array.isArray(obj.sentences) &&
    Array.isArray(obj.userInputs) &&
    typeof obj.score === "number"
  );
}

/** CorrectionResult 校验函数 */
export function isCorrectionResult(data: unknown): data is CorrectionResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.corrected_text === "string" &&
    Array.isArray(obj.corrections) &&
    typeof obj.summary === "string"
  );
}

/** 安全解析 JSON 字符串 */
export function parseResult(json: string): CorrectionResult | null {
  return extractJson<CorrectionResult>(json, isCorrectionResult);
}
