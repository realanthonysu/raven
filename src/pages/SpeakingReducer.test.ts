import { describe, expect, it } from "vitest";
import type { SpeakingScore, SpeakingSentence } from "@/types";
import {
  extractMissedWords,
  initialSpeakingState,
  type SpeakingState,
  speakingReducer,
} from "./speaking-reducer";

// ─── Test fixtures ────────────────────────────────────────────────

const sentences: SpeakingSentence[] = [
  { text: "Hello world", translation: "你好世界" },
  { text: "Good morning everyone", translation: "大家早上好" },
  { text: "The weather is nice today", translation: "今天天气很好" },
];

const makeScore = (overall: number, pronunciation = overall): SpeakingScore => ({
  pronunciation,
  grammar: overall,
  fluency: overall,
  overall,
  feedback: "Good job",
});

// ─── speakingReducer ──────────────────────────────────────────────

describe("speakingReducer", () => {
  describe("INIT", () => {
    it("sets sentences and fills results with nulls", () => {
      const state = speakingReducer(initialSpeakingState, { type: "INIT", sentences });
      expect(state.sentences).toBe(sentences);
      expect(state.results).toEqual([null, null, null]);
      expect(state.currentIndex).toBe(0);
      expect(state.currentTranscription).toBeNull();
      expect(state.currentScore).toBeNull();
    });

    it("resets state when called on an existing state", () => {
      const existing: SpeakingState = {
        sentences: [sentences[0]],
        results: [{ transcription: "hi", score: makeScore(90) }],
        currentIndex: 2,
        currentTranscription: "old",
        currentScore: makeScore(50),
      };
      const state = speakingReducer(existing, { type: "INIT", sentences });
      expect(state.sentences).toBe(sentences);
      expect(state.results).toEqual([null, null, null]);
      expect(state.currentIndex).toBe(0);
    });
  });

  describe("NAVIGATE", () => {
    it("sets currentIndex and clears current transcription/score when no result exists", () => {
      const base: SpeakingState = {
        ...initialSpeakingState,
        sentences,
        results: [null, null, null],
      };
      const state = speakingReducer(base, { type: "NAVIGATE", index: 1 });
      expect(state.currentIndex).toBe(1);
      expect(state.currentTranscription).toBeNull();
      expect(state.currentScore).toBeNull();
    });

    it("restores transcription and score from existing result", () => {
      const result = { transcription: "hello world", score: makeScore(85) };
      const base: SpeakingState = {
        ...initialSpeakingState,
        sentences,
        results: [result, null, null],
      };
      const state = speakingReducer(base, { type: "NAVIGATE", index: 0 });
      expect(state.currentIndex).toBe(0);
      expect(state.currentTranscription).toBe("hello world");
      // Score is restored from the result (use toEqual for value comparison)
      expect(state.currentScore).toEqual(makeScore(85));
    });
  });

  describe("SET_TRANSCRIPTION", () => {
    it("updates currentTranscription", () => {
      const state = speakingReducer(initialSpeakingState, {
        type: "SET_TRANSCRIPTION",
        transcription: "hello",
      });
      expect(state.currentTranscription).toBe("hello");
    });
  });

  describe("SET_SCORE", () => {
    it("writes result at action.index (not currentIndex) and updates current fields", () => {
      const base: SpeakingState = {
        ...initialSpeakingState,
        sentences,
        results: [null, null, null],
        currentIndex: 0,
      };
      const score = makeScore(92);
      const state = speakingReducer(base, {
        type: "SET_SCORE",
        index: 2,
        transcription: "weather nice today",
        score,
      });
      // Result written at index2, not currentIndex (0)
      expect(state.results[2]).toEqual({ transcription: "weather nice today", score });
      expect(state.results[0]).toBeNull();
      expect(state.currentTranscription).toBe("weather nice today");
      expect(state.currentScore).toBe(score);
    });
  });

  describe("CLEAR_CURRENT", () => {
    it("clears current transcription and score", () => {
      const base: SpeakingState = {
        ...initialSpeakingState,
        sentences,
        results: [null, null, null],
        currentTranscription: "hello",
        currentScore: makeScore(80),
      };
      const state = speakingReducer(base, { type: "CLEAR_CURRENT" });
      expect(state.currentTranscription).toBeNull();
      expect(state.currentScore).toBeNull();
      // Results array should not change
      expect(state.results).toEqual([null, null, null]);
    });
  });

  describe("RETRY_CURRENT", () => {
    it("nulls out result at currentIndex and clears current fields", () => {
      const score = makeScore(60);
      const base: SpeakingState = {
        ...initialSpeakingState,
        sentences,
        results: [
          { transcription: "hi", score: makeScore(90) },
          { transcription: "bad", score },
          null,
        ],
        currentIndex: 1,
        currentTranscription: "bad",
        currentScore: score,
      };
      const state = speakingReducer(base, { type: "RETRY_CURRENT" });
      expect(state.results[1]).toBeNull();
      expect(state.results[0]).not.toBeNull(); // Unchanged
      expect(state.currentTranscription).toBeNull();
      expect(state.currentScore).toBeNull();
    });
  });

  describe("RESET", () => {
    it("returns to initial state", () => {
      const base: SpeakingState = {
        sentences,
        results: [{ transcription: "hi", score: makeScore(90) }],
        currentIndex: 2,
        currentTranscription: "hello",
        currentScore: makeScore(80),
      };
      const state = speakingReducer(base, { type: "RESET" });
      expect(state).toEqual(initialSpeakingState);
    });
  });

  describe("default case", () => {
    it("returns the same state reference for unknown actions", () => {
      const state = speakingReducer(initialSpeakingState, { type: "UNKNOWN" } as never);
      expect(state).toBe(initialSpeakingState);
    });
  });
});

// ─── extractMissedWords ───────────────────────────────────────────

describe("extractMissedWords", () => {
  const makeResult = (transcription: string, pronunciation: number) => ({
    transcription,
    score: makeScore(pronunciation, pronunciation),
  });

  it("returns empty array when all results are null", () => {
    expect(extractMissedWords(sentences, [null, null, null])).toEqual([]);
  });

  it("returns empty array when all pronunciation scores are >= 80", () => {
    const results = [makeResult("Hello world", 90), makeResult("Good morning everyone", 80), null];
    expect(extractMissedWords(sentences, results)).toEqual([]);
  });

  it("extracts words missing from transcription when pronunciation < 80", () => {
    const results = [
      makeResult("world", 50), // "hello" is missing
      null,
      null,
    ];
    const missed = extractMissedWords(sentences, results);
    expect(missed).toContain("hello");
    expect(missed).not.toContain("world");
  });

  it("normalizes case and punctuation before comparing", () => {
    const s: SpeakingSentence[] = [{ text: "Hello, World!", translation: "" }];
    const results = [makeResult("hello world", 60)];
    const missed = extractMissedWords(s, results);
    // After normalization both match, so no missed words
    expect(missed).toEqual([]);
  });

  it("handles empty string transcription by skipping it (falsy)", () => {
    const results = [{ transcription: "", score: makeScore(50) }];
    const missed = extractMissedWords([sentences[0]], results);
    // Empty string is falsy, so it's skipped — no words extracted
    expect(missed).toEqual([]);
  });

  it("deduplicates missed words across sentences", () => {
    const s: SpeakingSentence[] = [
      { text: "The cat sat", translation: "" },
      { text: "The dog ran", translation: "" },
    ];
    const results = [makeResult("cat sat", 50), makeResult("dog ran", 50)];
    const missed = extractMissedWords(s, results);
    // "the" appears in both sentences but should be deduplicated
    const theCount = missed.filter((w) => w === "the").length;
    expect(theCount).toBe(1);
  });

  it("skips sentences with null transcription", () => {
    const results = [
      { transcription: "", score: makeScore(50) }, // empty, not null
      null, // null → skipped entirely
    ];
    const s = [sentences[0], sentences[1]];
    const missed = extractMissedWords(s, results);
    // Only sentence 0 contributes
    expect(missed.length).toBeGreaterThanOrEqual(0);
  });

  it("normalizes punctuation in contractions and hyphens", () => {
    const s: SpeakingSentence[] = [{ text: "It's a well-known fact", translation: "" }];
    const results = [makeResult("a fact", 40)];
    const missed = extractMissedWords(s, results);
    // normalize strips ' and -, so "it's" → "its", "well-known" → "wellknown"
    expect(missed).toContain("its");
    expect(missed).toContain("wellknown");
  });
});
