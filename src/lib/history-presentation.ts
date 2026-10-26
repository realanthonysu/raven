/**
 * 历史记录展示层注册表 —— HistoryRecord["type"] → 展示知识的单一映射点。
 *
 * 此前"类型 → 摘要/分数文案"的知识散落在三处 if-chain 中：
 * - DashboardPage.getRecordSummary（时间线预览 + 分数摘要）
 * - AnalyticsPage 近期记录区（分数徽章文本）
 * - HistoryDetailPage 的三个得分概览卡（exercise/listening/speaking，仅主题色/图标不同）
 * 新增一种活动类型需要同步改多处，漏改只会静默丢失展示信息。
 * 收敛到本模块后，新类型只需在 `historySummarizers` 登记一条（编译期强制穷举）。
 *
 * 视觉基色与图标不在此重复声明：图标直接引用 typeConfig 的同款组件；
 * 强调色因工具类形态不同（概览卡的 border-X-500/40 bg-X-500/5 vs 徽章的
 * bg-X-500/20 text-X-*）无法复用 typeConfig.color 字符串，只能按同色系单独列出。
 */
import type { LucideIcon } from "lucide-react";
import { formatDifficultyLabel } from "@/lib/levels";
import { extractJsonSafe } from "@/lib/parse-utils";
import {
  CorrectionResultSchema,
  ExerciseResultSchema,
  ListeningResultSchema,
  SpeakingResultSchema,
} from "@/lib/schemas";
import { typeConfig } from "@/lib/type-config";
import type { ExerciseResult, HistoryRecord, ListeningResult, SpeakingResult } from "@/types";

// ============================================================================
// 时间线摘要
// ============================================================================

/** 单条历史记录在列表/时间线中的摘要信息 */
interface HistorySummary {
  /** 预览文本；缺省时调用方回退为输入文本截断 */
  preview?: string;
  /** 分数摘要文本（如 "3 处错误"、"8/10"）；无分数概念时缺省 */
  scoreText?: string;
}

/**
 * 单类型的摘要提取器签名。
 *
 * @param fallbackPreview 输入文本截断后的默认预览——listening 的 topic 为空、
 *   writing 的 summary 为空串时需要回退到它，故由调用方传入而非各自重复截断逻辑
 * @param resultStr 持久化的 result JSON；缺失或结构不符时返回 null
 *   （结构异常的脏 JSON 不能强转使用，必须经 Zod schema 校验后才能取字段）
 */
export type HistorySummarizer = (
  fallbackPreview: string,
  resultStr?: string,
) => HistorySummary | null;

/** 写作批改（correct/writing 同构，共享同一提取器，兼容历史数据中两种 type 值） */
const writingSummarizer: HistorySummarizer = (fallbackPreview, resultStr) => {
  const parsed = resultStr ? extractJsonSafe(resultStr, CorrectionResultSchema) : null;
  if (!parsed) return null;
  return {
    preview: parsed.summary?.slice(0, 50) || fallbackPreview,
    scoreText: `${parsed.corrections.length} 处错误`,
  };
};

/** 练习结果 → 摘要（category 训练 + 得分/总题数） */
const exerciseSummarizer: HistorySummarizer = (_fallbackPreview, resultStr) => {
  const parsed = resultStr ? extractJsonSafe(resultStr, ExerciseResultSchema) : null;
  if (!parsed) return null;
  return {
    preview: `${parsed.category} 训练`,
    scoreText: `${parsed.score}/${parsed.exercises.length}`,
  };
};

/** 听力结果 → 摘要（topic 为空串时回退默认预览，与原实现行为一致） */
const listeningSummarizer: HistorySummarizer = (fallbackPreview, resultStr) => {
  const parsed = resultStr ? extractJsonSafe(resultStr, ListeningResultSchema) : null;
  if (!parsed) return null;
  return {
    preview: parsed.topic || fallbackPreview,
    scoreText: `${parsed.score}/${parsed.sentences.length}`,
  };
};

/** 口语结果 → 摘要（topic (难度) + 平均分）；难度经 formatDifficultyLabel 双标注渲染 */
const speakingSummarizer: HistorySummarizer = (_fallbackPreview, resultStr) => {
  const parsed = resultStr ? extractJsonSafe(resultStr, SpeakingResultSchema) : null;
  if (!parsed) return null;
  return {
    preview: `${parsed.topic} (${formatDifficultyLabel(parsed.difficulty)})`,
    scoreText: `平均 ${parsed.averageScore} 分`,
  };
};

/**
 * 记录类型 → 摘要提取器的注册表。
 *
 * 值类型用 Record 注解（与 HistoryDetailPage 的 DETAIL_COMPONENTS 同一思路）：
 * HistoryRecord["type"] 新增成员而未在此登记时直接编译报错，
 * 而非运行时静默回退到无分数的默认摘要。reading 是 markdown 长文，
 * 无可解析的分数概念，显式登记为恒 null 以满足穷举。
 */
export const historySummarizers: Record<HistoryRecord["type"], HistorySummarizer> = {
  correct: writingSummarizer,
  writing: writingSummarizer,
  reading: () => null,
  exercise: exerciseSummarizer,
  listening: listeningSummarizer,
  speaking: speakingSummarizer,
};

/**
 * 从历史记录中提取时间线摘要（DashboardPage 近期学习等处使用）。
 *
 * @param record - 轻量历史记录（getHistoryList 不含 result 字段）
 * @param result - 该记录的 result 内容（按 id 从 getHistoryWithResults 的
 *   resultById 取得；缺失或解析失败时退回输入文本预览、无分数文本）
 * @returns preview 恒非空；scoreText 得不出时为 null
 */
export function summarizeRecord(
  record: Pick<HistoryRecord, "type" | "input_text">,
  result?: string,
): { preview: string; scoreText: string | null } {
  const fallbackPreview =
    record.input_text.length > 50 ? `${record.input_text.slice(0, 50)}...` : record.input_text;

  const summary = historySummarizers[record.type](fallbackPreview, result);
  if (!summary) {
    return { preview: fallbackPreview, scoreText: null };
  }
  return {
    preview: summary.preview ?? fallbackPreview,
    scoreText: summary.scoreText ?? null,
  };
}

// ============================================================================
// 得分概览卡（HistoryDetailPage 的 exercise/listening/speaking 详情共用）
// ============================================================================

/** 得分概览卡的视觉主题：强调色类名 + 图标 */
export interface ScoreOverviewTheme {
  /** 图标组件（引用 typeConfig 的同款，保证两处视觉同源） */
  icon: LucideIcon;
  /** 卡片容器的边框/背景强调色类名（不含 rounded/padding 等结构类） */
  containerClass: string;
  /** 图标着色类名 */
  iconClass: string;
  /** 标题行着色类名 */
  titleClass: string;
}

/** 得分概览卡的文案内容，由各类型从已解析的 result 数据构造 */
export interface ScoreOverviewContent {
  /** 标题行（如 "训练类别：时态错误"） */
  title: string;
  /** 大号分数文本（如 "8/10"） */
  score: string;
  /** 分数后的单位说明（如 "正确"、"平均分"） */
  unit: string;
}

/**
 * 各得分型记录的概览卡配置。
 *
 * 仅 exercise/listening/speaking 具备"得分总览"结构；写作（纠正文本/逐条纠错）
 * 与阅读（六维分析 + 图谱）的详情结构差异过大，保持各自动态实现，不强塞进此契约。
 * content 入参按类型精确标注，消费方经具体键访问获得完整类型检查；
 * 键经 satisfies 约束必须落在合法的 HistoryRecord["type"] 内。
 */
export const scoreOverviews = {
  exercise: {
    theme: {
      icon: typeConfig.exercise.icon,
      containerClass: "border-orange-500/40 bg-orange-500/5",
      iconClass: "text-orange-600 dark:text-orange-400",
      titleClass: "text-orange-700 dark:text-orange-300",
    },
    content: (parsed: ExerciseResult): ScoreOverviewContent => ({
      title: `训练类别：${parsed.category}`,
      score: `${parsed.score}/${parsed.exercises.length}`,
      unit: "正确",
    }),
  },
  listening: {
    theme: {
      icon: typeConfig.listening.icon,
      containerClass: "border-cyan-500/40 bg-cyan-500/5",
      iconClass: "text-cyan-600 dark:text-cyan-400",
      titleClass: "text-cyan-700 dark:text-cyan-300",
    },
    content: (parsed: ListeningResult): ScoreOverviewContent => ({
      title: `听力练习：${parsed.topic} (${formatDifficultyLabel(parsed.difficulty)})`,
      score: `${parsed.score}/${parsed.sentences.length}`,
      unit: "正确",
    }),
  },
  speaking: {
    theme: {
      icon: typeConfig.speaking.icon,
      containerClass: "border-rose-500/40 bg-rose-500/5",
      iconClass: "text-rose-600 dark:text-rose-400",
      titleClass: "text-rose-700 dark:text-rose-300",
    },
    content: (parsed: SpeakingResult): ScoreOverviewContent => ({
      title: `口语练习：${parsed.topic} (${formatDifficultyLabel(parsed.difficulty)})`,
      score: `${parsed.averageScore}`,
      unit: "平均分",
    }),
  },
} as const satisfies Partial<Record<HistoryRecord["type"], unknown>>;

// ============================================================================
// 近期会话分数徽章（AnalyticsPage 近期记录区）
// ============================================================================

/** 会话分数展示所需的字段（SessionDetail 的结构子集，避免反向依赖 hook 层类型） */
interface SessionScoreSource {
  /** 得分 */
  score?: number;
  /** 满分值 */
  total?: number;
  /** 最常见错误类别（写作批改专用） */
  topCategory?: string;
}

/** 近期会话行的分数展示描述 */
export interface SessionScoreView {
  /** 类别徽章文本（仅写作批改有），渲染为 muted 小圆角标签 */
  categoryChip?: string;
  /** 主分数文本（如 "8/10"、"85分"） */
  text: string;
  /** 文本色：destructive=警示红（写作错误数），primary=主题色（其余得分） */
  tone: "primary" | "destructive";
}

/**
 * 推导近期会话行的分数展示；无可展示内容时返回 null（渲染处不输出任何元素）。
 * 类型 → 文案格式的知识原先以 if-chain 内联在 AnalyticsPage JSX 中。
 */
export function sessionScoreView(
  type: HistoryRecord["type"],
  s: SessionScoreSource,
): SessionScoreView | null {
  switch (type) {
    case "correct":
    case "writing":
      // BUG-4 修复：writing 与 correct 为同类写作批改记录，均显示错误类别 + 错误数
      return s.topCategory
        ? { categoryChip: s.topCategory, text: `${s.total} 处错误`, tone: "destructive" }
        : null;
    case "exercise":
    case "listening":
      return s.score !== undefined && s.total !== undefined
        ? { text: `${s.score}/${s.total}`, tone: "primary" }
        : null;
    case "speaking":
      return s.score !== undefined ? { text: `${s.score}分`, tone: "primary" } : null;
    default:
      // reading 为长文精读，无分数概念
      return null;
  }
}
