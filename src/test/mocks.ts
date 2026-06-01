import { vi } from "vitest";
import type { Word, ExerciseQuestion } from "@/types";

/**
 * Shared mock utilities for page-level and component-level tests.
 *
 * Usage:
 *   vi.mock("@/hooks/use-stream-chat", () => ({
 *     useStreamChat: () => createMockStreamChat(),
 *   }));
 */

// ─── useStreamChat mock ───────────────────────────────────────────

export interface MockStreamChat {
  loading: boolean;
  error: string | null;
  setError: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  abortRef: { current: AbortController | null };
}

/**
 * Creates a mock return value for the useStreamChat hook.
 *
 * The returned `execute` is a vi.fn() that, when called, stores its
 * arguments so tests can later invoke onDone/onError to drive the flow.
 *
 * Call `simulateSuccess(mock, fullText)` or `simulateError(mock, err)`
 * in tests to trigger the callbacks captured by execute.
 */
export function createMockStreamChat(): MockStreamChat {
  return {
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    abortRef: { current: null },
  };
}

/**
 * Simulate a successful LLM response by calling the onDone callback
 * that was passed to execute() by the page component.
 */
export function simulateSuccess(
  mock: MockStreamChat,
  fullText: string
): void {
  const call = mock.execute.mock.calls[0];
  if (!call) throw new Error("execute was never called");
  // execute signature: (systemPrompt, userContent, overrides?)
  const overrides = call[2] as { onDone?: (text: string) => void } | undefined;
  overrides?.onDone?.(fullText);
}

/**
 * Simulate an LLM error by calling the onError callback
 * that was passed to execute() by the page component.
 */
export function simulateError(
  mock: MockStreamChat,
  err: Error
): void {
  const call = mock.execute.mock.calls[0];
  if (!call) throw new Error("execute was never called");
  const overrides = call[2] as { onError?: (err: Error) => void } | undefined;
  overrides?.onError?.(err);
}

// ─── Database mocks ───────────────────────────────────────────────

export const mockDb = {
  getDefaultModel: vi.fn().mockResolvedValue({
    id: 1,
    name: "test",
    api_key: "sk-test",
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o-mini",
    is_default: true,
  }),
  addHistorySafe: vi.fn().mockResolvedValue(1),
  getReviewStats: vi.fn().mockResolvedValue({
    total: 10,
    newCount: 5,
    learningCount: 3,
    masteredCount: 2,
    dueCount: 5,
  }),
  getReviewWords: vi.fn().mockResolvedValue([]),
  updateWordReview: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
  recordLearningActivity: vi.fn().mockResolvedValue(undefined),
};

// ─── TTS mock ─────────────────────────────────────────────────────

export const mockTts = {
  speakText: vi.fn().mockResolvedValue(undefined),
};

// ─── Sample test data ─────────────────────────────────────────────

/** A sample set of fill-type exercises for testing ExercisePage */
export const sampleFillExercises: ExerciseQuestion[] = [
  {
    type: "fill",
    question: "She ___ (go) to school every day.",
    options: ["go", "goes", "going", "went"],
    answer: "goes",
    explanation: "主谓一致：第三人称单数用 goes",
  },
  {
    type: "fill",
    question: "They ___ (be) happy yesterday.",
    options: ["is", "are", "was", "were"],
    answer: "were",
    explanation: "过去时复数用 were",
  },
];

/** A sample correct-type exercise for testing */
export const sampleCorrectExercise: ExerciseQuestion = {
  type: "correct",
  question: "He go to school every day.",
  answer: "He goes to school every day.",
  explanation: "主谓一致：第三人称单数动词加 s",
};

/** Sample review words for testing ReviewPage */
export const sampleReviewWords: Word[] = [
  {
    id: 1,
    word: "ephemeral",
    phonetic: "/ɪˈfemərəl/",
    definition: "短暂的，转瞬即逝的",
    level: "CET-6",
    source_type: "reading",
    source_text: "The beauty of cherry blossoms is ephemeral.",
    notes: "搭配: ephemeral beauty, ephemeral nature\n例句: Fame is ephemeral.",
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
  },
  {
    id: 2,
    word: "ubiquitous",
    phonetic: "/juːˈbɪkwɪtəs/",
    definition: "无处不在的",
    level: "CET-6",
    source_type: "reading",
    source_text: "Smartphones have become ubiquitous.",
    notes: null,
    review_status: "learning",
    review_count: 2,
    next_review_at: "2026-05-25T00:00:00.000Z",
    created_at: "2026-05-02T00:00:00.000Z",
  },
];
