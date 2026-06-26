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
  /** 用户得分（0-100 百分制） */
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

export type Correction = z.infer<typeof CorrectionSchema>;

/** 完整的写作纠错结果：修正后全文、所有纠错项和总结 */
export const CorrectionResultSchema = z.object({
  /** LLM 修正后的完整文本 */
  corrected_text: z.string(),
  /** 所有纠错项列表 */
  corrections: z.array(CorrectionSchema),
  /** 对本次写作的总结性评价 */
  summary: z.string(),
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

/** 完整的听力练习结果：难度、主题、句子列表、用户输入和得分 */
export const ListeningResultSchema = z.object({
  /** 难度级别（如"初级"、"中级"、"高级"） */
  difficulty: z.string(),
  /** 练习主题（如"日常对话"、"商务英语"） */
  topic: z.string(),
  /** 听力句子列表 */
  sentences: z.array(ListeningSentenceSchema),
  /** 用户在每句上的听写输入 */
  userInputs: z.array(z.string()),
  /** 用户得分（0-100 百分制） */
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

export type SpeakingResultItem = z.infer<typeof SpeakingResultItemSchema>;

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

// ==================== Enriched Word ====================

/** 词汇丰富信息：LLM 补全的音标、释义、搭配和例句 */
export const EnrichedWordSchema = z.object({
  /** 国际音标（如 "/wɜːrd/"） */
  phonetic: z.string(),
  /** 中文释义 */
  definition: z.string(),
  /** 常见搭配短语 */
  collocations: z.string(),
  /** 例句 */
  example: z.string(),
});

export type EnrichedWord = z.infer<typeof EnrichedWordSchema>;

// ==================== Enums ====================

/** 词汇等级枚举：CET-4 / CET-6 / TEM-4 / TEM-8 */
export const WordLevelSchema = z.enum(["CET-4", "CET-6", "TEM-4", "TEM-8"]);
/** 复习状态枚举：new=新词, learning=学习中, mastered=已掌握 */
export const ReviewStatusSchema = z.enum(["new", "learning", "mastered"]);

// ==================== OpenAI Chat Completions audio/text responses ====================

/** TTS 音频模态响应的 schema（mimo / GPT-4o-audio-preview），data 为 base64 编码的音频 */
export const TTSAudioResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        audio: z.object({
          data: z.string(),
        }),
      }),
    }),
  ),
});

export type TTSAudioResponse = z.infer<typeof TTSAudioResponseSchema>;

/** ASR 文本响应的 schema（通过 Chat Completions API 调用 ASR 模型） */
export const ASRTextResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    }),
  ),
});

export type ASRTextResponse = z.infer<typeof ASRTextResponseSchema>;
