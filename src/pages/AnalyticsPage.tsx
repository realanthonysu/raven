import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getHistory } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { typeConfig } from "@/lib/type-config";
import type {
  HistoryRecord,
  CorrectionResult,
  ExerciseResult,
  ListeningResult,
} from "@/types";
import {
  BarChart3,
  TrendingUp,
  AlertTriangle,
  Target,
  Dumbbell,
  BookOpen,
  Headphones,
  BookCheck,
} from "lucide-react";
import { EmptyState, LoadingIndicator } from "@/components/page-states";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
} from "recharts";

/** 错误类型分布的统计数据 */
interface CategoryStat {
  name: string;
  count: number;
}

/** 趋势图中的单个数据点 */
interface TrendPoint {
  date: string;
  errors: number;
  index: number; // 第 N 篇
}

/** 成绩趋势图中的单个数据点 */
interface ScoreTrendPoint {
  date: string;
  scorePercent: number;
  label: string; // category 或 difficulty+topic
}

/** 最近会话详情列表的单条记录 */
interface SessionDetail {
  id: number;
  date: string;
  textPreview: string;
  type: HistoryRecord["type"];
  score?: number; // exercise/listening 的得分
  total?: number; // exercise/listening 的总题数
  topCategory?: string; // correct 类型的错误类别
}

/** 各错误类别的固定颜色映射，确保柱状图和饼图中同一类别颜色一致 */
const CATEGORY_COLORS: Record<string, string> = {
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
const PIE_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444",
  "#10b981", "#ec4899", "#6366f1", "#14b8a6", "#f97316", "#a855f7",
];

/**
 * 错误类别 → 能力维度映射。
 * 将 11 个错误类别归纳为 5 个非重叠的能力维度。
 */
const DIMENSION_MAP: Record<string, string> = {
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

/** 4 个能力维度的固定展示顺序和颜色（均有实际数据支撑） */
const DIMENSION_CONFIG: { name: string; color: string }[] = [
  { name: "语法", color: "#3b82f6" },
  { name: "词汇", color: "#f59e0b" },
  { name: "句式", color: "#10b981" },
  { name: "细节", color: "#8b5cf6" },
];

// 练习记录复用 DIMENSION_MAP 进行 category → 维度映射，避免重复定义

/**
 * 能力维度数据点。
 * @param dimension - 维度名称（语法/词汇/句式/细节）
 * @param score - 能力分数（0-100，越高越好）
 * @param trend - 改进趋势：improving=近期错误减少，declining=近期错误增加，stable=无明显变化，none=数据不足
 * @param color - 图表颜色
 */
interface CapabilityPoint {
  dimension: string;
  score: number;
  trend: "improving" | "declining" | "stable" | "none";
  color: string;
}

/** ExerciseResult 校验函数 */
function isExerciseResult(data: unknown): data is ExerciseResult {
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
function isListeningResult(data: unknown): data is ListeningResult {
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
function isCorrectionResult(data: unknown): data is CorrectionResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.corrected_text === "string" &&
    Array.isArray(obj.corrections) &&
    typeof obj.summary === "string"
  );
}

/** 安全解析 JSON 字符串，失败返回 null */
function parseResult(json: string): CorrectionResult | null {
  return extractJson<CorrectionResult>(json, isCorrectionResult);
}

/**
 * 数据分析页面（Analytics）。
 *
 * 功能：基于所有历史记录，生成综合学习分析报告。
 * 不新增数据库表——所有统计数据从现有 history 表的 result JSON 字段派生。
 *
 * 页面结构：
 * 1. 学习概览 — 总学习次数 + 各类型统计卡片
 * 2. 写作错误分析 — 错误趋势 + 错误分布（柱状图 + 饼图）
 * 3. 弱项训练成绩 — exercise 类型的成绩趋势折线图
 * 4. 听力练习成绩 — listening 类型的成绩趋势折线图
 * 5. 近期记录 — 最近的学习记录（所有类型）
 * 6. 弱项训练推荐 — 基于错误分析的训练建议
 */
/**
 * 学习分析页面（Analytics）。
 *
 * 读取所有历史记录（写作/阅读/练习/听力），提供多维度分析：
 * - 8 个概览统计卡片（总学习次数 + 各类型计数 + 错误统计）
 * - 学习画像雷达图（语法/词汇/句式/细节/表达 5 维能力评估）
 * - 错误类别分布（柱状图 + 饼图）
 * - 错误趋势折线图
 * - 弱项训练得分趋势图
 * - 听力练习得分趋势图
 * - 近期记录列表（所有类型，含彩色标签）
 * - 弱项训练推荐（基于最近 10 篇的高频错误类别）
 */
export default function AnalyticsPage() {
  const [allRecords, setAllRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  /** 挂载时加载所有历史记录 */
  useEffect(() => {
    getHistory().then((r) => {
      setAllRecords(r);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  // === 按类型分类记录 ===
  const correctRecords = useMemo(
    () => allRecords.filter((r) => r.type === "correct"),
    [allRecords]
  );
  const exerciseRecords = useMemo(
    () => allRecords.filter((r) => r.type === "exercise"),
    [allRecords]
  );
  const listeningRecords = useMemo(
    () => allRecords.filter((r) => r.type === "listening"),
    [allRecords]
  );
  const readingRecords = useMemo(
    () => allRecords.filter((r) => r.type === "reading"),
    [allRecords]
  );

  // ==================== 写作纠错分析 ====================

  /**
   * 解析所有 correct 记录的 result JSON，过滤掉解析失败的。
   * 这是所有后续统计的基础数据源。
   */
  const parsed = useMemo(() => {
    return correctRecords
      .map((r) => ({ record: r, result: parseResult(r.result) }))
      .filter((x): x is { record: HistoryRecord; result: CorrectionResult } => x.result !== null);
  }, [correctRecords]);

  // === 概览统计 ===
  const totalArticles = parsed.length;
  const totalErrors = parsed.reduce((sum, p) => sum + p.result.corrections.length, 0);
  const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";

  /** 统计所有错误类别的出现次数（Map<category, count>） */
  const allCategories = useMemo(() => {
    const map = new Map<string, number>();
    parsed.forEach((p) =>
      p.result.corrections.forEach((c) => {
        map.set(c.category, (map.get(c.category) ?? 0) + 1);
      })
    );
    return map;
  }, [parsed]);

  const uniqueCategories = allCategories.size;

  /** 柱状图和饼图的数据：按出现次数降序排列 */
  const categoryData: CategoryStat[] = useMemo(() => {
    return Array.from(allCategories.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allCategories]);

  /** 折线图数据：按时间排序，每篇对应一个数据点 */
  const trendData: TrendPoint[] = useMemo(() => {
    const sorted = [...parsed].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime()
    );
    return sorted.map((p, i) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }),
      errors: p.result.corrections.length,
      index: i + 1,
    }));
  }, [parsed]);

  /**
   * 改进趋势：将所有记录按时间均分为前后两半，
   * 比较平均错误数的变化。diff > 0 表示进步（错误减少）。
   */
  const improvement = useMemo(() => {
    if (trendData.length < 2) return null;
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid);
    const secondHalf = trendData.slice(mid);
    const avgFirst = firstHalf.reduce((s, d) => s + d.errors, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d.errors, 0) / secondHalf.length;
    const diff = avgFirst - avgSecond;
    const pct = avgFirst > 0 ? ((diff / avgFirst) * 100).toFixed(0) : "0";
    return { diff, pct, avgFirst: avgFirst.toFixed(1), avgSecond: avgSecond.toFixed(1) };
  }, [trendData]);

  // ==================== 弱项训练成绩趋势 ====================

  const exerciseTrendData: ScoreTrendPoint[] = useMemo(() => {
    const parsed_exercises = exerciseRecords
      .map((r) => ({
        record: r,
        result: extractJson<ExerciseResult>(r.result, isExerciseResult),
      }))
      .filter(
        (x): x is { record: HistoryRecord; result: ExerciseResult } =>
          x.result !== null
      );

    const sorted = parsed_exercises.sort(
      (a, b) =>
        new Date(a.record.created_at).getTime() -
        new Date(b.record.created_at).getTime()
    );

    return sorted.map((p) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent:
        p.result.exercises.length > 0
          ? Math.round(
              (p.result.score / p.result.exercises.length) * 100
            )
          : 0,
      label: `${p.result.category} (${p.result.score}/${p.result.exercises.length})`,
    }));
  }, [exerciseRecords]);

  // ==================== 听力练习成绩趋势 ====================

  const listeningTrendData: ScoreTrendPoint[] = useMemo(() => {
    const parsed_listening = listeningRecords
      .map((r) => ({
        record: r,
        result: extractJson<ListeningResult>(r.result, isListeningResult),
      }))
      .filter(
        (x): x is { record: HistoryRecord; result: ListeningResult } =>
          x.result !== null
      );

    const sorted = parsed_listening.sort(
      (a, b) =>
        new Date(a.record.created_at).getTime() -
        new Date(b.record.created_at).getTime()
    );

    return sorted.map((p) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      }),
      scorePercent:
        p.result.sentences.length > 0
          ? Math.round(
              (p.result.score / p.result.sentences.length) * 100
            )
          : 0,
      label: `${p.result.difficulty} - ${p.result.topic} (${p.result.score}/${p.result.sentences.length})`,
    }));
  }, [listeningRecords]);

  // ==================== 学习画像（能力雷达图） ====================

  /**
   * 计算 5 个能力维度的得分（0-100）。
   *
   * 算法：
   * 1. 对写作批改记录，统计每个维度下的错误总数和近期（后半段）错误数
   * 2. 得分 = 100 - (近期每篇平均错误 / 基准值 * 100)，基准值取所有维度中最高的平均错误数
   * 3. 对练习记录，计算每个维度下的平均正确率
   * 4. 最终得分 = 70% 写作得分 + 30% 练习得分
   * 5. 趋势：比较前后半段的平均错误数判断 improvement/declining/stable
   *
   * 无数据的维度默认 50 分（中性），避免空值误导。
   */
  const capabilityData = useMemo<CapabilityPoint[]>(() => {
    // 收集每个维度在每篇写作中的错误数
    const dimensionErrorsPerArticle: Record<string, number[]> = {};
    for (const dim of DIMENSION_CONFIG) {
      dimensionErrorsPerArticle[dim.name] = [];
    }

    // 按时间正序排列，便于前后半段比较
    const sortedParsed = [...parsed].sort(
      (a, b) =>
        new Date(a.record.created_at).getTime() -
        new Date(b.record.created_at).getTime()
    );

    for (const p of sortedParsed) {
      // 统计本篇中各维度的错误数
      const dimCounts: Record<string, number> = {};
      for (const dim of DIMENSION_CONFIG) {
        dimCounts[dim.name] = 0;
      }
      for (const c of p.result.corrections) {
        const dim = DIMENSION_MAP[c.category];
        if (dim) {
          dimCounts[dim] = (dimCounts[dim] ?? 0) + 1;
        }
      }
      for (const dim of DIMENSION_CONFIG) {
        dimensionErrorsPerArticle[dim.name].push(dimCounts[dim.name]);
      }
    }

    // 计算每个维度的全局平均错误数，用于归一化
    const dimensionAvgErrors: Record<string, number> = {};
    let maxAvg = 0;
    for (const dim of DIMENSION_CONFIG) {
      const errors = dimensionErrorsPerArticle[dim.name];
      const avg =
        errors.length > 0
          ? errors.reduce((s, e) => s + e, 0) / errors.length
          : 0;
      dimensionAvgErrors[dim.name] = avg;
      if (avg > maxAvg) maxAvg = avg;
    }

    // 收集练习记录各维度的得分百分比
    const exerciseScoresByDim: Record<string, number[]> = {};
    for (const dim of DIMENSION_CONFIG) {
      exerciseScoresByDim[dim.name] = [];
    }
    for (const r of exerciseRecords) {
      const result = extractJson<ExerciseResult>(r.result, isExerciseResult);
      if (!result) continue;
      const dim = DIMENSION_MAP[result.category];
      if (!dim) continue;
      const pct =
        result.exercises.length > 0
          ? (result.score / result.exercises.length) * 100
          : 0;
      exerciseScoresByDim[dim].push(pct);
    }

    return DIMENSION_CONFIG.map((dim) => {
      const errors = dimensionErrorsPerArticle[dim.name];
      const hasWritingData = errors.length > 0;

      // 写作得分：基于近期（后半段）每篇平均错误数的归一化
      let writingScore = 50; // 默认中性
      let trend: CapabilityPoint["trend"] = "none";

      if (hasWritingData) {
        const mid = Math.floor(errors.length / 2);
        const recentErrors = mid > 0 ? errors.slice(mid) : errors;
        const recentAvg =
          recentErrors.reduce((s, e) => s + e, 0) / recentErrors.length;

        // 归一化：相对于最大平均错误数
        writingScore =
          maxAvg > 0
            ? Math.max(0, Math.min(100, 100 - (recentAvg / maxAvg) * 100))
            : 100;

        // 趋势判断：比较前后半段
        if (errors.length >= 2) {
          const firstHalf = errors.slice(0, mid || 1);
          const secondHalf = errors.slice(mid || 1);
          const avgFirst =
            firstHalf.reduce((s, e) => s + e, 0) / firstHalf.length;
          const avgSecond =
            secondHalf.reduce((s, e) => s + e, 0) / secondHalf.length;
          if (avgFirst - avgSecond > 0.3) trend = "improving";
          else if (avgSecond - avgFirst > 0.3) trend = "declining";
          else trend = "stable";
        }
      }

      // 练习得分
      const exScores = exerciseScoresByDim[dim.name];
      const exerciseScore =
        exScores.length > 0
          ? exScores.reduce((s, v) => s + v, 0) / exScores.length
          : null;

      // 混合得分：70% 写作 + 30% 练习（无练习数据时纯用写作）
      let finalScore: number;
      if (exerciseScore !== null && hasWritingData) {
        finalScore = Math.round(writingScore * 0.7 + exerciseScore * 0.3);
      } else if (hasWritingData) {
        finalScore = Math.round(writingScore);
      } else if (exerciseScore !== null) {
        finalScore = Math.round(exerciseScore);
      } else {
        finalScore = 50;
      }

      return {
        dimension: dim.name,
        score: finalScore,
        trend,
        color: dim.color,
      };
    });
  }, [parsed, exerciseRecords]);

  /** 最强维度 */
  const bestDimension = useMemo(() => {
    if (capabilityData.length === 0) return "";
    const hasData = capabilityData.some((d) => d.score !== 50);
    if (!hasData) return "暂无足够数据";
    return capabilityData.reduce((best, d) =>
      d.score > best.score ? d : best
    ).dimension;
  }, [capabilityData]);

  /** 最弱维度 */
  const worstDimension = useMemo(() => {
    if (capabilityData.length === 0) return "";
    const hasData = capabilityData.some((d) => d.score !== 50);
    if (!hasData) return "暂无足够数据";
    return capabilityData.reduce((worst, d) =>
      d.score < worst.score ? d : worst
    ).dimension;
  }, [capabilityData]);

  // ==================== 近期记录（所有类型） ====================

  const recentSessions: SessionDetail[] = useMemo(() => {
    const allSorted = [...allRecords].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return allSorted.slice(0, 15).map((r) => {
      const base: SessionDetail = {
        id: r.id,
        date: new Date(r.created_at).toLocaleDateString("zh-CN"),
        textPreview: r.input_text.slice(0, 60) + (r.input_text.length > 60 ? "..." : ""),
        type: r.type,
      };

      if (r.type === "correct") {
        const result = parseResult(r.result);
        if (result) {
          const catMap = new Map<string, number>();
          result.corrections.forEach((c) =>
            catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1)
          );
          base.topCategory =
            Array.from(catMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
          base.total = result.corrections.length;
        }
      } else if (r.type === "exercise") {
        const result = extractJson<ExerciseResult>(r.result, isExerciseResult);
        if (result) {
          base.score = result.score;
          base.total = result.exercises.length;
        }
      } else if (r.type === "listening") {
        const result = extractJson<ListeningResult>(r.result, isListeningResult);
        if (result) {
          base.score = result.score;
          base.total = result.sentences.length;
        }
      }

      return base;
    });
  }, [allRecords]);

  /**
   * 弱项推荐算法。
   *
   * 输入：parsed 数组（所有写作批改记录的解析结果）
   * 输出：频次最高的 1-2 个错误类别（{ name, count }[]）
   *
   * 算法步骤：
   * 1. 取最近 10 篇记录（越近的越能反映当前水平）
   * 2. 遍历每篇的 corrections 数组，统计各 category 的出现次数
   * 3. 按频次降序排序，取 top 2
   *
   * 使用 useMemo 缓存，仅在 parsed 变化时重新计算。
   * 下游使用：渲染"弱项训练"推荐卡片，点击后导航到 /exercise/:category。
   */
  const weakCategories: { name: string; count: number }[] = useMemo(() => {
    const recent = parsed.slice(0, 10); // 最近 10 篇，越新越有参考价值
    if (recent.length === 0) return [];

    // 统计各错误类别的出现频次
    const catMap = new Map<string, number>();
    recent.forEach((p) =>
      p.result.corrections.forEach((c) => {
        catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
      })
    );

    // 按频次降序，取 top 2 作为推荐
    return Array.from(catMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 2);
  }, [parsed]);

  // 加载中
  if (loading) {
    return <LoadingIndicator text="加载中..." className="h-full" />;
  }

  // 空状态：没有任何记录
  if (allRecords.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="暂无学习数据"
        subtitle="开始使用 Writing Copilot、阅读精读、弱项训练或听力练习后，这里会展示学习分析"
        className="h-full"
      />
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-bold tracking-tight">学习分析</h1>
        <p className="text-sm text-muted-foreground">基于 {allRecords.length} 条学习记录的综合分析</p>
      </div>

      {/* === 学习概览：总览 + 各类型统计 === */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<BarChart3 className="h-4 w-4" />}
          label="总学习次数"
          value={String(allRecords.length)}
        />
        <StatCard
          icon={<BookCheck className="h-4 w-4" />}
          label="写作批改"
          value={String(correctRecords.length)}
        />
        <StatCard
          icon={<BookOpen className="h-4 w-4" />}
          label="阅读精读"
          value={String(readingRecords.length)}
        />
        <StatCard
          icon={<Dumbbell className="h-4 w-4" />}
          label="弱项训练"
          value={String(exerciseRecords.length)}
        />
        <StatCard
          icon={<Headphones className="h-4 w-4" />}
          label="听力练习"
          value={String(listeningRecords.length)}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="总错误数"
          value={String(totalErrors)}
        />
        <StatCard
          icon={<Target className="h-4 w-4" />}
          label="平均错误/篇"
          value={avgErrors}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="错误类型数"
          value={String(uniqueCategories)}
          sub={
            improvement && improvement.diff > 0
              ? `↓ ${improvement.pct}% 进步`
              : improvement && improvement.diff < 0
                ? `↑ ${improvement.pct}% 增加`
                : undefined
          }
        />
      </div>

      {/* === 学习画像：能力雷达图 === */}
      {capabilityData.length > 0 && correctRecords.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Target className="h-4 w-4" />
            学习画像
          </h2>
          <div className="flex flex-col items-center">
            <RadarChart
              outerRadius={120}
              width={400}
              height={300}
              data={capabilityData}
            >
              <PolarGrid />
              <PolarAngleAxis
                dataKey="dimension"
                tick={{ fontSize: 13, fill: "hsl(var(--foreground))" }}
              />
              <PolarRadiusAxis
                angle={90}
                domain={[0, 100]}
                tick={{ fontSize: 10 }}
                tickCount={5}
              />
              <Radar
                name="能力"
                dataKey="score"
                stroke="#8884d8"
                fill="#8884d8"
                fillOpacity={0.3}
                strokeWidth={2}
              />
            </RadarChart>
          </div>

          {/* 各维度详情 */}
          <div className="grid grid-cols-5 gap-2 mt-4">
            {capabilityData.map((d) => (
              <div key={d.dimension} className="text-center">
                <p className="text-xs text-muted-foreground">{d.dimension}</p>
                <p
                  className="text-lg font-bold"
                  style={{
                    color:
                      d.score >= 70
                        ? "#10b981"
                        : d.score >= 40
                          ? "#f59e0b"
                          : "#ef4444",
                  }}
                >
                  {d.score}
                </p>
                <p className="text-xs">
                  {d.trend === "improving" && (
                    <span className="text-green-600">↑ 进步</span>
                  )}
                  {d.trend === "declining" && (
                    <span className="text-red-500">↓ 退步</span>
                  )}
                  {d.trend === "stable" && (
                    <span className="text-muted-foreground">→ 稳定</span>
                  )}
                  {d.trend === "none" && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </p>
              </div>
            ))}
          </div>

          {/* 能力总结 */}
          <div className="mt-4 pt-3 border-t text-sm text-muted-foreground flex gap-6">
            <p>
              <strong className="text-foreground">最强项：</strong>
              {bestDimension}
            </p>
            <p>
              <strong className="text-foreground">最弱项：</strong>
              {worstDimension}
            </p>
          </div>
        </div>
      )}

      {/* === 错误趋势折线图（至少 2 篇数据才显示） === */}
      {trendData.length > 1 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误趋势</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="index" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip
                  formatter={(value: any) => [`${value} 个错误`, "错误数"]}
                  labelFormatter={(label: any) => `第 ${label} 篇`}
                />
                <Line
                  type="monotone"
                  dataKey="errors"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 错误类型分布 - 水平柱状图（中文标签需要更多左侧空间） */}
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误类型分布</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData} layout="vertical" margin={{ left: 80, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={75}
                  tick={{ fontSize: 12 }}
                />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any) => [`${value} 次`, "出现次数"]} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {categoryData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 错误类型占比 - 环形饼图（内半径 50 形成环形效果） */}
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误类型占比</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="count"
                  nameKey="name"
                  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                  label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {categoryData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any) => [`${value} 次`, "出现次数"]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* === 弱项训练成绩趋势（至少 2 条数据才显示） === */}
      {exerciseTrendData.length > 1 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">弱项训练成绩</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={exerciseTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip
                  formatter={(value: any) => [`${value}%`, "正确率"]}
                  labelFormatter={(_label: any, payload: any) => {
                    if (payload && payload.length > 0) {
                      return payload[0].payload.label;
                    }
                    return "";
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="scorePercent"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 听力练习成绩趋势（至少 2 条数据才显示） === */}
      {listeningTrendData.length > 1 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">听力练习成绩</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={listeningTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip
                  formatter={(value: any) => [`${value}%`, "正确率"]}
                  labelFormatter={(_label: any, payload: any) => {
                    if (payload && payload.length > 0) {
                      return payload[0].payload.label;
                    }
                    return "";
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="scorePercent"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 近期记录列表（所有类型，最多 15 条） === */}
      {recentSessions.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">近期记录</h2>
          <div className="space-y-2">
            {recentSessions.map((s) => {
              const config = typeConfig[s.type];
              const TypeIcon = config.icon;
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-2 border-b last:border-0 cursor-pointer hover:bg-muted/50 rounded-sm px-2 -mx-2 transition-colors"
                  onClick={() => navigate(`/history/${s.id}`)}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs shrink-0 ${config.color}`}
                    >
                      <TypeIcon className="h-3 w-3" />
                      {config.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{s.textPreview}</p>
                      <p className="text-xs text-muted-foreground">{s.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0">
                    {s.type === "correct" && s.topCategory && (
                      <>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                          {s.topCategory}
                        </span>
                        <span className="text-sm font-medium text-destructive">
                          {s.total} 处错误
                        </span>
                      </>
                    )}
                    {(s.type === "exercise" || s.type === "listening") &&
                      s.score !== undefined &&
                      s.total !== undefined && (
                        <span className="text-sm font-medium text-primary">
                          {s.score}/{s.total}
                        </span>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 弱项训练推荐：基于 weakCategories 算法的输出，展示 top 2 高频错误类别 */}
      {/* 仅在有推荐数据时渲染（weakCategories 非空） */}
      {weakCategories.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">弱项训练</h2>
          <p className="text-xs text-muted-foreground mb-4">
            基于最近 10 篇批改记录，系统推荐以下弱项进行专项训练
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {weakCategories.map((cat) => (
              <div
                key={cat.name}
                className="flex items-center justify-between p-3 border rounded-lg hover:border-primary/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-orange-500/10 flex items-center justify-center">
                    <Dumbbell className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{cat.name}</p>
                    <p className="text-xs text-muted-foreground">近 10 篇出现 {cat.count} 次</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => navigate(`/exercise/${encodeURIComponent(cat.name)}`)}
                >
                  开始训练
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 统计概览卡片组件。
 * 用于展示单个指标（如批改篇数、总错误数等）。
 *
 * @param icon - 左侧图标
 * @param label - 指标名称
 * @param value - 指标数值
 * @param sub - 可选的副文本（如进步百分比，显示为绿色）
 */
function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="border rounded-lg p-4 space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-green-600">{sub}</p>}
    </div>
  );
}
