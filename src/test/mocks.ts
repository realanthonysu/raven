import { vi } from "vitest";
import type { ExerciseQuestion, Word } from "@/types";

/**
 * Shared mock utilities for page-level and component-level tests.
 *
 * Design principles:
 * 1. Factory functions (create*) return fresh instances — no shared mutable state between tests.
 * 2. Each factory is independently usable — tests pick only what they need.
 * 3. No embedded business logic in mocks — return fixed/parameterized values only.
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
}

/**
 * Creates a mock return value for the useStreamChat hook.
 *
 * The returned `execute` is a vi.fn() that, when called, stores its
 * arguments so tests can later invoke onDone/onError to drive the flow.
 */
export function createMockStreamChat(): MockStreamChat {
  return {
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
  };
}

// ─── Database mock factories ──────────────────────────────────────

/** Default model fixture used by createMockGetDefaultModelCached. */
const defaultModelFixture = {
  id: 1,
  name: "test",
  api_key: "sk-test",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** Default review stats fixture used by createMockGetReviewStats. */
const defaultReviewStatsFixture = {
  total: 10,
  newCount: 5,
  learningCount: 3,
  masteredCount: 2,
  dueCount: 5,
};

/** Creates a mock getDefaultModelCached that resolves to a model config. */
export function createMockGetDefaultModelCached() {
  return vi.fn().mockResolvedValue(defaultModelFixture);
}

/** Creates a mock getReviewStats that resolves to review statistics. */
export function createMockGetReviewStats() {
  return vi.fn().mockResolvedValue(defaultReviewStatsFixture);
}

/** Creates a mock getReviewWords that resolves to an empty array. */
export function createMockGetReviewWords() {
  return vi.fn().mockResolvedValue([]);
}

/**
 * Creates a mock calculateAndUpdateReview that returns a fixed result.
 *
 * No embedded FSRS logic — the result is deterministic and trivial.
 * Tests that need specific return values can override via mockReturnValue/mockResolvedValue.
 */
export function createMockCalculateAndUpdateReview() {
  return vi.fn().mockResolvedValue({
    status: "learning",
    interval: 2,
    next_review_at: "2026-08-01 00:00:00",
    card: {
      stability: 1.2,
      difficulty: 5.5,
      elapsed_days: 0,
      scheduled_days: 2,
      reps: 1,
      lapses: 0,
      state: 2,
    },
  });
}

/** Creates a mock addHistorySafe that resolves to a fixed ID. */
export function createMockAddHistorySafe() {
  return vi.fn().mockResolvedValue(1);
}

/** Creates a mock recordLearningActivitySafe (fire-and-forget, no return). */
export function createMockRecordLearningActivitySafe() {
  return vi.fn();
}

/** Creates a mock getHistory that resolves to an empty array. */
export function createMockGetHistory() {
  return vi.fn().mockResolvedValue([]);
}

/**
 * Creates a complete mock db module object with fresh instances of all functions.
 *
 * Each call returns a new object with new vi.fn() instances, preventing
 * cross-test state leakage. Tests that need specific behavior can override
 * individual functions via mockReturnValueOnce etc.
 */
export function createMockDb() {
  return {
    getDefaultModelCached: createMockGetDefaultModelCached(),
    getDefaultModel: createMockGetDefaultModelCached(),
    addHistorySafe: createMockAddHistorySafe(),
    getReviewStats: createMockGetReviewStats(),
    getReviewWords: createMockGetReviewWords(),
    calculateAndUpdateReview: createMockCalculateAndUpdateReview(),
    getHistory: createMockGetHistory(),
    recordLearningActivity: vi.fn().mockResolvedValue(undefined),
    recordLearningActivitySafe: createMockRecordLearningActivitySafe(),
    buildPersonalizedContext: vi.fn().mockResolvedValue(""),
  };
}

// ─── Mock execute helpers ─────────────────────────────────────────

/**
 * Configures a mockStreamChat.execute to simulate a successful LLM response.
 * The onDone callback is invoked asynchronously (via setTimeout) to mimic real behavior.
 */
export function mockExecuteWithResult(mockStreamChat: MockStreamChat, fullText: string) {
  mockStreamChat.execute = vi
    .fn()
    .mockImplementation(
      (
        _prompt: string,
        _user: string,
        overrides: { onDone?: (text: string) => void; onError?: (err: Error) => void },
      ) => {
        setTimeout(() => overrides.onDone?.(fullText), 0);
        return Promise.resolve();
      },
    );
}

/**
 * Configures a mockStreamChat.execute to simulate an LLM error.
 * The onError callback is invoked asynchronously (via setTimeout) to mimic real behavior.
 */
export function mockExecuteWithError(mockStreamChat: MockStreamChat, err: Error) {
  mockStreamChat.execute = vi
    .fn()
    .mockImplementation(
      (_prompt: string, _user: string, overrides: { onError?: (err: Error) => void }) => {
        setTimeout(() => overrides.onError?.(err), 0);
        return Promise.resolve();
      },
    );
}

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
