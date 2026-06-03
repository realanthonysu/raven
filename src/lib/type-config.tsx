/**
 * 共享类型/阅读配置 —— 供 HistoryPage、Sidebar 等多处复用。
 *
 * 集中管理两种功能的视觉标识（颜色、图标、标签），
 * 避免在各组件中重复硬编码。
 */
import {
  BookCheck,
  BookOpen,
  Dumbbell,
  FileText,
  Globe,
  Headphones,
  Languages,
  Lightbulb,
  Search,
} from "lucide-react";
import type { ExerciseType } from "@/types";

/**
 * 功能类型配置 —— 键名对应 history 表的 type 字段值。
 * `as const` 使类型收窄为字面量类型，方便 TypeScript 推断。
 * 颜色类名同时包含 light/dark 模式变体，适配 Tailwind dark: 前缀。
 */
export const typeConfig = {
  correct: {
    label: "Writing",
    icon: BookCheck,
    color: "bg-green-500/20 text-green-600 dark:text-green-400",
  },
  reading: {
    label: "Reading",
    icon: BookOpen,
    color: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  },
  exercise: {
    label: "Exercise",
    icon: Dumbbell,
    color: "bg-orange-500/20 text-orange-600 dark:text-orange-400",
  },
  listening: {
    label: "Listening",
    icon: Headphones,
    color: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  },
} as const;

/**
 * Reading Copilot 分析维度配置 —— 键名对应 LLM 返回的 markdown 中的 ## 标题。
 *
 * LLM 被 prompt 要求按这 6 个维度输出分析结果，`parseSections()` 按 ## 分割后
 * 用此处的键名匹配标题，渲染对应的图标和格式化标题。
 * 键名使用中文（如"参考翻译"），因为 LLM 输出的标题是中文。
 */
export const readingSectionConfig: Record<string, { title: string; icon: React.ReactNode }> = {
  参考翻译: { title: "📖 参考翻译", icon: <Languages className="h-4 w-4" /> },
  重点词汇: { title: "📝 重点词汇", icon: <BookOpen className="h-4 w-4" /> },
  句子拆解: { title: "🔍 句子拆解", icon: <Search className="h-4 w-4" /> },
  语法分析: { title: "📐 语法分析", icon: <FileText className="h-4 w-4" /> },
  背景与技巧: { title: "🌍 背景与技巧", icon: <Globe className="h-4 w-4" /> },
  延伸思考: { title: "💡 延伸思考", icon: <Lightbulb className="h-4 w-4" /> },
};

/**
 * 各错误类别对应的题型映射。
 * 决定 LLM 生成哪种类型的练习题。
 * Used by ExercisePage to build prompts and by AnalyticsPage for recommendations.
 */
export const CATEGORY_EXERCISE_TYPE: Record<string, ExerciseType> = {
  时态错误: "fill",
  主谓一致: "fill",
  单复数: "fill",
  冠词错误: "correct",
  介词错误: "correct",
  用词不当: "rewrite",
  句式杂糅: "rewrite",
  拼写错误: "rewrite",
  标点错误: "rewrite",
  缺少成分: "rewrite",
  语序错误: "rewrite",
};

/** 题型的中文说明，用于 prompt 和 UI 展示 */
export const EXERCISE_TYPE_LABEL: Record<ExerciseType, string> = {
  fill: "填空题（选择正确的词形或选项）",
  correct: "改错题（找出并改正句中的错误）",
  rewrite: "重写题（用正确的方式重写句子）",
};
