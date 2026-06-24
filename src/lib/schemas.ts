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

export const SpeakingScoreSchema = z.object({
  pronunciation: z.number(),
  grammar: z.number(),
  fluency: z.number(),
  overall: z.number(),
  feedback: z.string(),
});

export type SpeakingScore = z.infer<typeof SpeakingScoreSchema>;

export const SpeakingResultItemSchema = z.object({
  sentence: SpeakingSentenceSchema,
  transcription: z.string(),
  score: SpeakingScoreSchema,
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
