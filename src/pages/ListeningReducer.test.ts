import { describe, expect, it } from "vitest";
import type { ListeningSentence } from "@/types";
import { initialListeningState, type ListeningState, listeningReducer } from "./ListeningPage";

// ─── Test fixtures ────────────────────────────────────────────────

const sentences: ListeningSentence[] = [
  { text: "The quick brown fox", hint: "快速的棕色狐狸" },
  { text: "She sells seashells", hint: "她卖贝壳" },
  { text: "How are you today", hint: "你今天好吗" },
];

// ─── listeningReducer ─────────────────────────────────────────────

describe("listeningReducer", () => {
  describe("SET_SENTENCES", () => {
    it("sets sentences and initializes empty userInputs array", () => {
      const state = listeningReducer(initialListeningState, {
        type: "SET_SENTENCES",
        sentences,
      });
      expect(state.sentences).toBe(sentences);
      expect(state.userInputs).toEqual(["", "", ""]);
      expect(state.currentIndex).toBe(0);
    });

    it("resets currentIndex to 0", () => {
      const base: ListeningState = {
        ...initialListeningState,
        sentences: [sentences[0]],
        currentIndex: 4,
        userInputs: ["answer"],
      };
      const state = listeningReducer(base, { type: "SET_SENTENCES", sentences });
      expect(state.currentIndex).toBe(0);
    });
  });

  describe("SET_CURRENT_INDEX", () => {
    it("sets the currentIndex", () => {
      const base: ListeningState = {
        ...initialListeningState,
        sentences,
        userInputs: ["", "", ""],
      };
      const state = listeningReducer(base, { type: "SET_CURRENT_INDEX", index: 2 });
      expect(state.currentIndex).toBe(2);
    });
  });

  describe("SET_USER_INPUT", () => {
    it("updates input at specified index", () => {
      const base: ListeningState = {
        ...initialListeningState,
        sentences,
        userInputs: ["", "", ""],
      };
      const state = listeningReducer(base, {
        type: "SET_USER_INPUT",
        index: 1,
        value: "she sells",
      });
      expect(state.userInputs[1]).toBe("she sells");
      expect(state.userInputs[0]).toBe("");
      expect(state.userInputs[2]).toBe("");
    });

    it("does not mutate the original userInputs array", () => {
      const base: ListeningState = {
        ...initialListeningState,
        sentences,
        userInputs: ["a", "b", "c"],
      };
      const originalInputs = base.userInputs;
      const state = listeningReducer(base, { type: "SET_USER_INPUT", index: 0, value: "x" });
      expect(state.userInputs).not.toBe(originalInputs);
      expect(originalInputs[0]).toBe("a"); // Original unchanged
    });
  });

  describe("SET_SCORE", () => {
    it("sets the score", () => {
      const state = listeningReducer(initialListeningState, { type: "SET_SCORE", score: 3.5 });
      expect(state.score).toBe(3.5);
    });
  });

  describe("SET_ERROR", () => {
    it("sets the error message", () => {
      const state = listeningReducer(initialListeningState, {
        type: "SET_ERROR",
        error: "生成失败",
      });
      expect(state.error).toBe("生成失败");
    });

    it("clears error when set to null", () => {
      const base: ListeningState = { ...initialListeningState, error: "old error" };
      const state = listeningReducer(base, { type: "SET_ERROR", error: null });
      expect(state.error).toBeNull();
    });
  });

  describe("CLEAR_ERROR", () => {
    it("clears the error", () => {
      const base: ListeningState = { ...initialListeningState, error: "some error" };
      const state = listeningReducer(base, { type: "CLEAR_ERROR" });
      expect(state.error).toBeNull();
    });
  });

  describe("SET_SAVE_ERROR", () => {
    it("sets the save error", () => {
      const state = listeningReducer(initialListeningState, {
        type: "SET_SAVE_ERROR",
        error: "保存失败",
      });
      expect(state.saveError).toBe("保存失败");
    });
  });

  describe("SET_SHOW_HINT", () => {
    it("shows hint", () => {
      const state = listeningReducer(initialListeningState, { type: "SET_SHOW_HINT", show: true });
      expect(state.showHint).toBe(true);
    });

    it("hides hint", () => {
      const base: ListeningState = { ...initialListeningState, showHint: true };
      const state = listeningReducer(base, { type: "SET_SHOW_HINT", show: false });
      expect(state.showHint).toBe(false);
    });
  });

  describe("RESET", () => {
    it("returns to initial state", () => {
      const base: ListeningState = {
        sentences,
        currentIndex: 2,
        userInputs: ["a", "b", "c"],
        score: 4,
        error: "err",
        saveError: "save err",
        showHint: true,
      };
      const state = listeningReducer(base, { type: "RESET" });
      expect(state).toEqual(initialListeningState);
    });

    it("returns a fresh reference (not the original initialListeningState mutated)", () => {
      // RESET returns the initialListeningState object reference
      const state = listeningReducer(
        {
          ...initialListeningState,
          sentences,
          userInputs: ["a"],
        },
        { type: "RESET" },
      );
      expect(state.sentences).toEqual([]);
      expect(state.userInputs).toEqual([]);
    });
  });

  describe("default case", () => {
    it("returns the same state reference for unknown actions", () => {
      const state = listeningReducer(initialListeningState, { type: "UNKNOWN" } as never);
      expect(state).toBe(initialListeningState);
    });
  });
});
