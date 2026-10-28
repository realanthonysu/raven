import type { ExerciseQuestion, Word } from "@/types";

/**
 * Shared test fixtures for page-level and component-level tests.
 *
 * Design principles:
 * 1. Each export is independently usable — tests pick only what they need.
 * 2. No embedded business logic — fixed/parameterized values only.
 */

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
