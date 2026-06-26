/**
 * Analytics 模块的常量、类型和辅助函数。
 *
 * 从 AnalyticsPage.tsx 中抽取，供 useAnalytics hook 和 AnalyticsPage 共用。
 */

import { extractJson } from "@/lib/parse-utils";
import {
  type CorrectionResult,
  CorrectionResultSchema,
  type ExerciseResult,
  ExerciseResultSchema,
  type ListeningResult,
  ListeningResultSchema,
  type SpeakingResult,
  SpeakingResultSchema,
} from "@/lib/schemas";
import type { HistoryRecord } from "@/types";

// ==================== 常量 ====================

/** 各错误类别的固定颜色映射，确保柱状图和饼图中同一类别颜色一致 */
export const CATEGORY_COLORS: Record<string, string> = {
  主谓一致: "#3b82f6",
  冠词错误: "#8b5cf6",
  单复数: "#06b6d4",
  用词不当: "#f59e0b",
  时态错误: "#ef4444",
  拼写错误: "#10b981",
  介词错误: "#ec4899",
  句式杂糅: "#6366f1",
  标点错误: "#14b8a6",
  缺少成分: "#f97316",
  语序错误: "#a855f7",
};

/** 饼图的备用颜色（当类别不在 CATEGORY_COLORS 中时使用） */
export const PIE_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#06b6d4",
  "#f59e0b",
  "#ef4444",
  "#10b981",
  "#ec4899",
  "#6366f1",
  "#14b8a6",
  "#f97316",
  "#a855f7",
];

/**
 * 错误类别 → 能力维度映射。
 * 将 11 个错误类别归纳为 4 个非重叠的能力维度。
 */
export const DIMENSION_MAP: Record<string, string> = {
  时态错误: "语法",
  主谓一致: "语法",
  介词错误: "语法",
  用词不当: "词汇",
  拼写错误: "词汇",
  句式杂糅: "句式",
  缺少成分: "句式",
  语序错误: "句式",
  冠词错误: "细节",
  单复数: "细节",
  标点错误: "细节",
};

/** 能力维度的固定展示顺序和颜色（含写作/练习的 4 维 + 听力/口语） */
export const DIMENSION_CONFIG: { name: string; color: string }[] = [
  { name: "语法", color: "#3b82f6" },
  { name: "词汇", color: "#f59e0b" },
  { name: "句式", color: "#10b981" },
  { name: "细节", color: "#8b5cf6" },
  { name: "听力", color: "#06b6d4" },
  { name: "口语", color: "#f43f5e" },
];

// ==================== 类型 ====================

/** 错误类型分布的统计数据，用于柱状图和饼图渲染 */
export interface CategoryStat {
  /** 错误类别名称（如"时态错误"） */
  name: string;
  /** 该类别的出现次数 */
  count: number;
}

/** 错误数量趋势图中的单个数据点 */
export interface TrendPoint {
  /** 日期标签（如 "01/15"） */
  date: string;
  /** 该次练习的错误总数 */
  errors: number;
  /** 数据点序号（用于图表 X 轴定位） */
  index: number;
}

/** 成绩趋势图中的单个数据点 */
export interface ScoreTrendPoint {
  /** 日期标签（如 "01/15"） */
  date: string;
  /** 得分百分比（0-100） */
  scorePercent: number;
  /** 图表 tooltip 显示的完整标签（含分数详情） */
  label: string;
}

/** 近期会话详情列表的单条记录，用于 AnalyticsPage 底部的会话列表 */
export interface SessionDetail {
  /** history 表主键 ID */
  id: number;
  /** 格式化的日期字符串 */
  date: string;
  /** 用户输入文本的前 N 个字符预览 */
  textPreview: string;
  /** 功能类型（correct / reading / exercise / listening / speaking） */
  type: HistoryRecord["type"];
  /** 得分（如有评分的题型） */
  score?: number;
  /** 满分值 */
  total?: number;
  /** 该次练习中出现最多的错误类别 */
  topCategory?: string;
}

/** 能力维度数据点，用于雷达图展示各维度得分和趋势 */
export interface CapabilityPoint {
  /** 维度名称（语法/词汇/句式/细节/听力/口语） */
  dimension: string;
  /** 该维度的综合得分（0-100） */
  score: number;
  /** 趋势方向：improving=进步, declining=退步, stable=持平, none=无历史数据 */
  trend: "improving" | "declining" | "stable" | "none";
  /** 该维度在图表中的主题色 */
  color: string;
}

// ==================== 校验函数 ====================

/**
 * Runtime type guard：校验未知数据是否为合法的 ExerciseResult。
 * @param data - 待校验的未知数据（通常来自 JSON.parse）
 * @returns 类型守卫结果
 */
export function isExerciseResult(data: unknown): data is ExerciseResult {
  return ExerciseResultSchema.safeParse(data).success;
}

/**
 * Runtime type guard：校验未知数据是否为合法的 ListeningResult。
 * @param data - 待校验的未知数据（通常来自 JSON.parse）
 * @returns 类型守卫结果
 */
export function isListeningResult(data: unknown): data is ListeningResult {
  return ListeningResultSchema.safeParse(data).success;
}

/**
 * Runtime type guard：校验未知数据是否为合法的 CorrectionResult。
 * @param data - 待校验的未知数据（通常来自 JSON.parse）
 * @returns 类型守卫结果
 */
export function isCorrectionResult(data: unknown): data is CorrectionResult {
  return CorrectionResultSchema.safeParse(data).success;
}

/**
 * Runtime type guard：校验未知数据是否为合法的 SpeakingResult。
 * @param data - 待校验的未知数据（通常来自 JSON.parse）
 * @returns 类型守卫结果
 */
export function isSpeakingResult(data: unknown): data is SpeakingResult {
  return SpeakingResultSchema.safeParse(data).success;
}

/**
 * 从 JSON 字符串中安全解析 CorrectionResult。
 *
 * 委托给 extractJson + isCorrectionResult 校验，
 * 解析或校验失败时返回 null，不抛出异常。
 *
 * @param json - 原始 JSON 字符串（通常来自 history 表的 result 字段）
 * @returns 解析成功返回 CorrectionResult，失败返回 null
 */
export function parseResult(json: string): CorrectionResult | null {
  return extractJson<CorrectionResult>(json, isCorrectionResult);
}
