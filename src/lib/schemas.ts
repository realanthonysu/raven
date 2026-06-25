/**
 * Zod schemas for runtime validation of LLM JSON output.
 *
 * These schemas replace hand-written type guards and also infer
 * the TypeScript types they validate, keeping types and runtime
 * checks in a single source of truth.
 */

import { z } from "zod";

// ==================== Exercise ====================

export const ExerciseTypeSchema = z.enum(["fill", "correct", "rewrite"]);
export type ExerciseType = z.infer<typeof ExerciseTypeSchema>;

export const ExerciseQuestionSchema = z.object({
  type: ExerciseTypeSchema,
  question: z.string(),
  options: z.array(z.string()).optional(),
  answer: z.string(),
  explanation: z.string(),
});

export type ExerciseQuestion = z.infer<typeof ExerciseQuestionSchema>;

export const ExerciseResultSchema = z.object({
  category: z.string(),
  exercises: z.array(ExerciseQuestionSchema),
  userAnswers: z.array(z.string()),
  score: z.number(),
});

export type ExerciseResult = z.infer<typeof ExerciseResultSchema>;

// ==================== Correction ====================

export const CorrectionSchema = z.object({
  original: z.string(),
  corrected: z.string(),
  category: z.string(),
  explanation: z.string(),
});

export type Correction = z.infer<typeof CorrectionSchema>;

export const CorrectionResultSchema = z.object({
  corrected_text: z.string(),
  corrections: z.array(CorrectionSchema),
  summary: z.string(),
});

export type CorrectionResult = z.infer<typeof CorrectionResultSchema>;

// ==================== Listening ====================

export const ListeningSentenceSchema = z.object({
  text: z.string(),
  hint: z.string(),
});

export type ListeningSentence = z.infer<typeof ListeningSentenceSchema>;

export const ListeningResultSchema = z.object({
  difficulty: z.string(),
  topic: z.string(),
  sentences: z.array(ListeningSentenceSchema),
  userInputs: z.array(z.string()),
  score: z.number(),
});

export type ListeningResult = z.infer<typeof ListeningResultSchema>;

// ==================== Speaking ====================

export const SpeakingSentenceSchema = z.object({
  text: z.string(),
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
  word: z.string(),
  ipa: z.string(),
  status: z.enum(["correct", "mispronounced", "missed"]),
});

export type WordAlignmentItem = z.infer<typeof WordAlignmentItemSchema>;

export const SpeakingScoreSchema = z.object({
  pronunciation: z.number(),
  grammar: z.number(),
  fluency: z.number(),
  overall: z.number(),
  feedback: z.string(),
  /** 词级对齐 + IPA 音标，可选字段（旧数据无此字段时向后兼容） */
  wordAlignment: z.array(WordAlignmentItemSchema).optional(),
});

export type SpeakingScore = z.infer<typeof SpeakingScoreSchema>;

export const SpeakingResultItemSchema = z.object({
  sentence: SpeakingSentenceSchema,
  transcription: z.string(),
  // 问题 17: 允许 score 为 null，用于标记用户跳过/未完成的句子，
  // 避免用零分对象污染 analytics 趋势数据
  score: SpeakingScoreSchema.nullable(),
  // 问题 17: 显式标记该句是否被跳过（未完成），旧数据无此字段时视为未跳过
  skipped: z.boolean().optional(),
});

export type SpeakingResultItem = z.infer<typeof SpeakingResultItemSchema>;

export const SpeakingResultSchema = z.object({
  difficulty: z.string(),
  topic: z.string(),
  sentences: z.array(SpeakingSentenceSchema),
  results: z.array(SpeakingResultItemSchema),
  averageScore: z.number(),
});

export type SpeakingResult = z.infer<typeof SpeakingResultSchema>;

// ==================== Enriched Word ====================

export const EnrichedWordSchema = z.object({
  phonetic: z.string(),
  definition: z.string(),
  collocations: z.string(),
  example: z.string(),
});

export type EnrichedWord = z.infer<typeof EnrichedWordSchema>;

// ==================== Enums ====================

export const WordLevelSchema = z.enum(["CET-4", "CET-6", "TEM-4", "TEM-8"]);
export const ReviewStatusSchema = z.enum(["new", "learning", "mastered"]);

// ==================== OpenAI Chat Completions audio/text responses ====================

/** Schema for TTS audio modality response (mimo / GPT-4o-audio-preview). */
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

/** Schema for ASR text response via Chat Completions API. */
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
