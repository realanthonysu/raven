/**
 * 共享类型/功能配置 —— 供 HistoryPage、Sidebar 等多处复用。
 *
 * 集中管理功能类型（Writing/Reading/Exercise/Listening/Speaking）、
 * 阅读分析维度、以及练习题型映射的视觉标识（颜色、图标、标签），
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
  Mic,
  Search,
} from "lucide-react";
import type { ExerciseType, HistoryRecord, WordLevel } from "@/types";

/**
 * 功能类型配置 —— 键名对应 history 表的 type 字段值。
 * `as const` 使类型收窄为字面量类型，方便 TypeScript 推断。
 * 颜色类名同时包含 light/dark 模式变体，适配 Tailwind dark: 前缀。
 */
/** Writing 功能的共享配置（`correct` 与 `writing` 指向同一配置，兼容历史数据中两种 type 值） */
const writingConfig = {
  label: "Writing",
  icon: BookCheck,
  color: "bg-green-500/20 text-green-600 dark:text-green-400",
} as const;

export const typeConfig = {
  correct: writingConfig,
  writing: writingConfig,
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
  speaking: {
    label: "Speaking",
    icon: Mic,
    color: "bg-rose-500/20 text-rose-600 dark:text-rose-400",
  },
} as const;

/** history.type 的全部合法值集合（与 typeConfig 键同源，避免两处清单漂移） */
const HISTORY_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(typeConfig));

/**
 * 运行时类型守卫：校验历史记录的 type 值是否合法。
 *
 * `HistoryRecord["type"]` 只是编译期联合——SQLite 返回的是裸字符串，
 * 脏数据（手工改库、旧版本遗留值）在运行时可能不在联合内。
 * 渲染 DB 数据前应先经此守卫：非法值跳过或降级展示，而非崩溃。
 */
export function isHistoryType(type: string): type is HistoryRecord["type"] {
  return HISTORY_TYPE_SET.has(type);
}

/**
 * Reading Copilot 分析维度的 section 键名 —— 单一事实来源。
 *
 * 键名对应 LLM 返回的 markdown 中的 ## 标题（中文，因为 LLM 输出标题是中文）。
 * 页面逻辑分支（如"该 section 按词汇渲染"）必须引用此常量而非内联中文字符串，
 * 与 readingSectionConfig 及 prompts 中的标题约定保持一致。
 */
export const READING_SECTION_KEY = {
  /** 参考翻译 */
  translation: "参考翻译",
  /** 重点词汇（按 VocabularySection 结构化渲染） */
  vocabulary: "重点词汇",
  /** 句子拆解 */
  sentenceBreakdown: "句子拆解",
  /** 语法分析 */
  grammar: "语法分析",
  /** 背景与技巧 */
  background: "背景与技巧",
  /** 延伸思考 */
  reflection: "延伸思考",
} as const;

/**
 * Reading Copilot 分析维度配置 —— 键名来自 [`READING_SECTION_KEY`]。
 *
 * LLM 被 prompt 要求按这 6 个维度输出分析结果，`parseSections()` 按 ## 分割后
 * 用此处的键名匹配标题，渲染对应的图标和格式化标题。
 */
export const readingSectionConfig: Record<string, { title: string; icon: React.ReactNode }> = {
  [READING_SECTION_KEY.translation]: {
    title: "📖 参考翻译",
    icon: <Languages className="h-4 w-4" />,
  },
  [READING_SECTION_KEY.vocabulary]: {
    title: "📝 重点词汇",
    icon: <BookOpen className="h-4 w-4" />,
  },
  [READING_SECTION_KEY.sentenceBreakdown]: {
    title: "🔍 句子拆解",
    icon: <Search className="h-4 w-4" />,
  },
  [READING_SECTION_KEY.grammar]: { title: "📐 语法分析", icon: <FileText className="h-4 w-4" /> },
  [READING_SECTION_KEY.background]: { title: "🌍 背景与技巧", icon: <Globe className="h-4 w-4" /> },
  [READING_SECTION_KEY.reflection]: {
    title: "💡 延伸思考",
    icon: <Lightbulb className="h-4 w-4" />,
  },
};

/**
 * 各错误类别对应的题型映射。
 *
 * 决定 LLM 生成哪种类型的练习题：
 * - 语法类错误（时态、主谓一致、单复数）→ fill（填空题）
 * - 细节类错误（冠词、介词）→ correct（改错题）
 * - 综合类错误（用词、句式、拼写等）→ rewrite（重写题）
 *
 * 由 ExercisePage 构建 prompt 和 AnalyticsPage 生成推荐时共用。
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

/** 各词汇等级标签的颜色映射，用于 Badge 组件的 className（VocabularyPage 等处复用） */
export const LEVEL_COLORS: Record<WordLevel, string> = {
  小学: "bg-slate-500/20 text-slate-600 dark:text-slate-400",
  中考: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  高考: "bg-teal-500/20 text-teal-600 dark:text-teal-400",
  "CET-4": "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "CET-6": "bg-green-500/20 text-green-600 dark:text-green-400",
  考研: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  "TEM-4": "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  "TEM-8": "bg-red-500/20 text-red-600 dark:text-red-400",
  雅思: "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400",
  托福: "bg-orange-500/20 text-orange-600 dark:text-orange-400",
  超纲: "bg-zinc-500/20 text-zinc-600 dark:text-zinc-400",
};
