/**
 * Zod schemas —— LLM JSON 输出的运行时校验。
 *
 * 使用 Zod 定义所有 LLM 返回结构的 schema，同时通过 `z.infer` 推导 TypeScript 类型，
 * 保证类型定义和运行时校验的单一数据源（single source of truth）。
 * 替代手写 type guard，消除类型与校验逻辑不一致的风险。
 */

import { z } from "zod";

// ==================== Exercise ====================

/** 练习题型枚举：fill=填空, correct=改错, rewrite=重写 */
export const ExerciseTypeSchema = z.enum(["fill", "correct", "rewrite"]);
export type ExerciseType = z.infer<typeof ExerciseTypeSchema>;

/** 单道练习题的结构：包含题型、题干、可选项、正确答案和解析 */
export const ExerciseQuestionSchema = z.object({
  /** 题型 */
  type: ExerciseTypeSchema,
  /** 题干文本 */
  question: z.string(),
  /** 选择题的候选项列表（填空题使用，改错/重写题无此字段） */
  options: z.array(z.string()).optional(),
  /** 正确答案 */
  answer: z.string(),
  /** 答案解析说明 */
  explanation: z.string(),
});

export type ExerciseQuestion = z.infer<typeof ExerciseQuestionSchema>;

/** 完整的练习结果：包含类别、题目列表、用户答案和得分 */
export const ExerciseResultSchema = z.object({
  /** 练习针对的错误类别（如"时态错误"） */
  category: z.string(),
  /** 题目列表 */
  exercises: z.array(ExerciseQuestionSchema),
  /** 用户在每题上的答案 */
  userAnswers: z.array(z.string()),
  /** 答对题数（0 - exercises.length，非百分制；展示时如 `${score}/${total}`） */
  score: z.number(),
});

export type ExerciseResult = z.infer<typeof ExerciseResultSchema>;

// ==================== Correction ====================

/** 单处纠错记录：原始文本、修正后文本、错误类别和解析说明 */
export const CorrectionSchema = z.object({
  original: z.string(),
  corrected: z.string(),
  /** 错误类别（如"时态错误"、"主谓一致"） */
  category: z.string(),
  /** 错误原因说明 */
  explanation: z.string(),
});

/** 完整的写作纠错结果：修正后全文、所有纠错项、总结与写作水平估级 */
export const CorrectionResultSchema = z.object({
  /** LLM 修正后的完整文本 */
  corrected_text: z.string(),
  /** 所有纠错项列表 */
  corrections: z.array(CorrectionSchema),
  /** 对本次写作的总结性评价 */
  summary: z.string(),
  /**
   * 本次写作的水平估级（CEFR 级别体系，Writing Copilot 专用）。
   * nullish：兼容旧数据（此前 LLM 输出不含该字段）与 LLM 输出 null
   * （部分模型对无估级把握时显式返回 null，拒绝会让整篇结果解析失败）。
   * band 用宽松 z.string() —— LLM 可能输出六档之外的意外值，
   * 合法性由展示层经 isLevelCode 兜底校验后再决定是否渲染。
   */
  level_estimate: z
    .object({
      band: z.string(),
      rationale: z.string(),
    })
    .nullish(),
});

export type CorrectionResult = z.infer<typeof CorrectionResultSchema>;

// ==================== Listening ====================

/** 听力练习单句：目标文本和提示信息 */
export const ListeningSentenceSchema = z.object({
  /** 原始听力文本 */
  text: z.string(),
  /** 给用户的听力提示（如语速、关键词提示） */
  hint: z.string(),
});

export type ListeningSentence = z.infer<typeof ListeningSentenceSchema>;

/**
 * 语言检测结果 —— DETECT_PROMPT 的 LLM 响应结构。
 * 判断输入文本是否为英文，并给出简短原因。
 */
export const LanguageDetectionSchema = z.object({
  /** 是否为英文 */
  isEnglish: z.boolean(),
  /** 检测原因说明（中文，LLM 可能省略或返回 null） */
  reason: z.string().nullish(),
});

export type LanguageDetection = z.infer<typeof LanguageDetectionSchema>;

/**
 * 知识图谱数据 —— GRAPH_DATA_PROMPT 的 LLM 响应结构。
 * 从文本中提取核心概念（节点）和关系（边），用于 Cytoscape 图谱渲染。
 */
export const GraphDataSchema = z.object({
  nodes: z.array(
    z.object({
      /** 节点唯一标识 */
      id: z.string(),
      /** 中文标签 */
      label: z.string(),
      /** 英文标签（LLM 可能省略或返回 null） */
      labelEn: z.string().nullish(),
      /** 节点类型：word / concept / entity */
      type: z.string(),
    }),
  ),
  edges: z.array(
    z.object({
      /** 关系起点节点 id */
      source: z.string(),
      /** 关系终点节点 id */
      target: z.string(),
      /** 关系描述（如同义、反义、搭配、因果等） */
      relation: z.string(),
    }),
  ),
});

export type GraphData = z.infer<typeof GraphDataSchema>;

/** 完整的听力练习结果：难度、主题、句子列表、用户输入和得分 */
export const ListeningResultSchema = z.object({
  /** 难度级别：新数据为 CEFR 级别码（"B2" 等，见 lib/levels.ts），旧数据为"初级/中级/高级"——展示经 formatDifficultyLabel 归一 */
  difficulty: z.string(),
  /** 练习主题（如"日常对话"、"商务英语"） */
  topic: z.string(),
  /** 听力句子列表 */
  sentences: z.array(ListeningSentenceSchema),
  /** 用户在每句上的听写输入 */
  userInputs: z.array(z.string()),
  /** 答对句数（0 - sentences.length，可含 0.5，非百分制；消费方按百分制使用时经 listeningScorePercent 归一） */
  score: z.number(),
});

export type ListeningResult = z.infer<typeof ListeningResultSchema>;

// ==================== Speaking ====================

/** 口语练习单句：目标文本和中文翻译 */
export const SpeakingSentenceSchema = z.object({
  /** 英文目标句子 */
  text: z.string(),
  /** 中文翻译（供用户理解句意） */
  translation: z.string(),
});

export type SpeakingSentence = z.infer<typeof SpeakingSentenceSchema>;

/**
 * 词级对齐结果 —— 标记原句中每个词的发音状态。
 * - correct: 转写中正确匹配
 * - mispronounced: 转写中有近似词但发音有误
 * - missed: 转写中缺失（漏读）
 */
export const WordAlignmentItemSchema = z.object({
  /** 原句中的单词 */
  word: z.string(),
  /** 该词的标准 IPA 音标 */
  ipa: z.string(),
  /** 发音状态：correct=正确, mispronounced=发音有误, missed=漏读 */
  status: z.enum(["correct", "mispronounced", "missed"]),
});

export type WordAlignmentItem = z.infer<typeof WordAlignmentItemSchema>;

/** 单句口语评分：发音、语法、流畅度、综合分、文字反馈和词级对齐 */
export const SpeakingScoreSchema = z.object({
  /** 发音得分（0-100） */
  pronunciation: z.number(),
  /** 语法得分（0-100） */
  grammar: z.number(),
  /** 流畅度得分（0-100） */
  fluency: z.number(),
  /** 综合得分（0-100） */
  overall: z.number(),
  /** LLM 生成的文字反馈建议 */
  feedback: z.string(),
  /** 词级对齐 + IPA 音标，可选字段（旧数据无此字段时向后兼容） */
  wordAlignment: z.array(WordAlignmentItemSchema).optional(),
});

export type SpeakingScore = z.infer<typeof SpeakingScoreSchema>;

/** 单句口语练习结果：句子、用户转写、评分和跳过状态 */
export const SpeakingResultItemSchema = z.object({
  sentence: SpeakingSentenceSchema,
  /** ASR 识别的用户语音转写文本 */
  transcription: z.string(),
  // 问题 17: 允许 score 为 null，用于标记用户跳过/未完成的句子，
  // 避免用零分对象污染 analytics 趋势数据
  score: SpeakingScoreSchema.nullable(),
  // 问题 17: 显式标记该句是否被跳过（未完成），旧数据无此字段时视为未跳过
  skipped: z.boolean().optional(),
});

/** 完整的口语练习结果：难度、主题、句子列表、逐句结果和平均分 */
export const SpeakingResultSchema = z.object({
  /** 难度级别 */
  difficulty: z.string(),
  /** 练习主题 */
  topic: z.string(),
  /** 句子列表 */
  sentences: z.array(SpeakingSentenceSchema),
  /** 逐句练习结果 */
  results: z.array(SpeakingResultItemSchema),
  /** 所有句子的平均综合得分 */
  averageScore: z.number(),
});

export type SpeakingResult = z.infer<typeof SpeakingResultSchema>;

// ==================== Learning ====================

/**
 * 每日学习活动计数 —— learning_streaks.activities JSON 的运行时校验。
 * 键为活动类型（writing / reading / exercise / listening / speaking / review），
 * 值为当日完成次数。getSidebarData 解析 today_activities 时使用，
 * 结构不符时 fail-soft 退化为空对象，保证打卡展示不崩溃。
 */
export const DailyActivitiesSchema = z.record(z.string(), z.number());

// ==================== Word Level Enum ====================

/**
 * 词汇等级枚举 —— 中国英语考试体系锚点。
 * CET-4/6 为大学英语四六级，TEM-4/8 为英语专业四八级；
 * 小学/中考/高考/考研为学段锚点，雅思/托福为出国考试锚点，超纲为超出国内体系的词。
 * 扩展枚举向后兼容：旧值（CET-4/6、TEM-4/8）仍合法，存量数据不受影响。
 * 与 Rust 侧 repository::validate_word_level 白名单对齐。
 */
export const WordLevelSchema = z.enum([
  "小学",
  "中考",
  "高考",
  "CET-4",
  "CET-6",
  "考研",
  "TEM-4",
  "TEM-8",
  "雅思",
  "托福",
  "超纲",
]);
export type WordLevel = z.infer<typeof WordLevelSchema>;

// ==================== Enriched Word ====================

/** 词汇丰富信息：LLM 补全的音标、释义、搭配、例句与等级标签 */
export const EnrichedWordSchema = z.object({
  /** 国际音标（如 "/wɜːrd/"） */
  phonetic: z.string(),
  /** 中文释义 */
  definition: z.string(),
  /** 常见搭配短语 */
  collocations: z.string(),
  /** 例句 */
  example: z.string(),
  /**
   * 该词在中国英语考试体系中的典型归属（LLM 自动标注）。
   * nullish：兼容旧数据（此前 LLM 输出不含该字段）与 LLM 输出 null。
   * 宽松 z.string() —— LLM 可能输出 11 值之外的意外等级（如 GRE），
   * 严格 enum 会让 extractJsonSafe 整对象校验失败、连音标/释义/搭配/例句
   * 一并丢弃；合法性在写库前经 toWordLevel 归一化，与 level_estimate.band
   * 的宽松 schema 模式一致（schema 宽松、写库严格）。
   */
  level: z.string().nullish(),
});

export type EnrichedWord = z.infer<typeof EnrichedWordSchema>;

// ==================== Placement（AI 定级测试） ====================

/**
 * AI 定级测试单题 —— PLACEMENT_PROMPT 的 LLM 响应元素。
 * band/answer/options 的有效性由 lib/level-estimation.ts 的
 * isUsablePlacementQuestion 在计分前再校验（schema 宽松、计分严格）。
 */
export const PlacementQuestionSchema = z.object({
  /** 题干（自包含,不依赖上下文） */
  question: z.string(),
  /** 恰好 4 个选项 */
  options: z.array(z.string()),
  /** 正确选项原文（必须与 options 中某一项完全一致） */
  answer: z.string(),
  /** 该题级别档（LEVEL_CODES 之一:A2/B1/B1+/B2/B2+/C1） */
  band: z.string(),
  /** 考点说明（词汇/语法/搭配,供结果页展示） */
  focus: z.string().optional(),
});

export type PlacementQuestion = z.infer<typeof PlacementQuestionSchema>;

/**
 * 定级测试结果 —— settings 表 placement_result 键的运行时结构。
 * estimated_level 为规则计分（scorePlacement）的产物,非 LLM 直接输出。
 */
export const PlacementResultSchema = z.object({
  /** 测试完成时间（ISO 字符串） */
  tested_at: z.string(),
  /** 估计级别码 */
  estimated_level: z.string(),
  /** 各档正确率:band → (0-1] 精度的小数,如 { "B1": 1, "B2": 0.5 } */
  per_band: z.record(z.string(), z.number()),
  /** 有效题数 */
  question_count: z.number(),
  /**
   * 答对题数。可选以兼容本字段上线前保存的旧结果——读取方缺失时
   * 回退到按 per_band 还原（近似值）。
   */
  total_correct: z.number().optional(),
});

export type PlacementResult = z.infer<typeof PlacementResultSchema>;

// ==================== Enums ====================

/** 复习状态枚举：new=新词, learning=学习中, mastered=已掌握 */
export const ReviewStatusSchema = z.enum(["new", "learning", "mastered"]);

// ==================== Word（生词本词条） ====================

/**
 * 生词本词条 schema —— words 表行的运行时校验，`Word` 类型的单一事实来源。
 *
 * types/index.ts 的 `Word` 类型由此派生（z.infer）；ReviewPage 的 localStorage
 * 会话校验复用同一 schema。此前两处字段清单各自手写，words 表加列时容易漏改
 * 导致会话校验静默失败——现在只需改这一处。
 * FSRS 字段为 optional：兼容 migration 007 之前的存量数据。
 */
export const WordSchema = z.object({
  id: z.number(),
  word: z.string(),
  phonetic: z.string().nullable(),
  definition: z.string(),
  level: WordLevelSchema.nullable(),
  source_type: z.string().nullable(),
  source_text: z.string().nullable(),
  notes: z.string().nullable(),
  review_status: ReviewStatusSchema,
  review_count: z.number().optional(),
  next_review_at: z.string().nullable().optional(),
  created_at: z.string(),
  stability: z.number().optional(),
  difficulty: z.number().optional(),
  elapsed_days: z.number().optional(),
  scheduled_days: z.number().optional(),
  reps: z.number().optional(),
  lapses: z.number().optional(),
  state: z.number().optional(),
});

// ==================== 列表信封（共享工厂） ====================

/**
 * 「{ <key>: 元素数组 }」信封 schema 的共享工厂。
 *
 * 此前 ExercisePage / ListeningPage / SpeakingPage 各自手写同构的 LLM 生成结果
 * 校验信封（仅键名 exercises / sentences 与是否 nonempty 不同），统一收敛到本工厂，
 * 避免多份声明随时间漂移。nonempty=true 保留听力页原语义：空列表校验失败，
 * 按"LLM 输出不可用"处理并走重试路径。
 */
export function makeListEnvelope<K extends string, S extends z.ZodType>(
  key: K,
  elementSchema: S,
  opts?: { nonempty?: boolean },
): z.ZodObject<{ [P in K]: z.ZodArray<S> }> {
  // zod v4 的 .nonempty() 返回 this，两分支类型一致（nonempty 仅追加运行时最小长度检查）
  const list = opts?.nonempty ? z.array(elementSchema).nonempty() : z.array(elementSchema);
  // 泛型键名无法被字面量推断捕获，这里显式断言为精确的映射形状
  return z.object({ [key]: list }) as z.ZodObject<{ [P in K]: z.ZodArray<S> }>;
}

// ==================== OpenAI Chat Completions audio/text responses ====================
// （生产代码不解析响应结构——TTS/ASR 代理在 Rust 侧处理；如需 WebView 侧校验再补充 schema）
