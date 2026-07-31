import { describe, expect, it } from "vitest";
import type { ExerciseQuestion } from "@/types";
import { type ExerciseState, exerciseReducer, initialExerciseState } from "./exercise-reducer";

// ─── Test fixtures ────────────────────────────────────────────────

const exercises: ExerciseQuestion[] = [
  { type: "fill", question: "She ___ to school.", answer: "goes", explanation: "三单" },
  { type: "correct", question: "He go home.", answer: "He goes home.", explanation: "三单" },
  { type: "rewrite", question: "Rewrite it.", answer: "It was rewritten.", explanation: "被动" },
];

// ─── exerciseReducer ──────────────────────────────────────────────

describe("exerciseReducer", () => {
  describe("SET_EXERCISES", () => {
    it("sets exercises and answers together", () => {
      const state = exerciseReducer(initialExerciseState, {
        type: "SET_EXERCISES",
        exercises,
        answers: ["", "", ""],
      });
      expect(state.exercises).toBe(exercises);
      expect(state.userAnswers).toEqual(["", "", ""]);
    });

    it("preserves unrelated state slots", () => {
      const base: ExerciseState = { ...initialExerciseState, score: 2, error: "old" };
      const state = exerciseReducer(base, {
        type: "SET_EXERCISES",
        exercises,
        answers: ["", "", ""],
      });
      expect(state.score).toBe(2);
      expect(state.error).toBe("old");
    });
  });

  describe("SET_ANSWER", () => {
    it("updates answer at specified index immutably", () => {
      const base: ExerciseState = {
        ...initialExerciseState,
        exercises,
        userAnswers: ["", "", ""],
      };
      const state = exerciseReducer(base, { type: "SET_ANSWER", index: 1, value: "He goes home." });
      expect(state.userAnswers).toEqual(["", "He goes home.", ""]);
      // 不可变更新：原数组不受影响
      expect(base.userAnswers).toEqual(["", "", ""]);
      expect(state.userAnswers).not.toBe(base.userAnswers);
    });
  });

  describe("SET_SCORE", () => {
    it("sets the score", () => {
      const state = exerciseReducer(initialExerciseState, { type: "SET_SCORE", score: 3 });
      expect(state.score).toBe(3);
    });
  });

  describe("SET_ERROR / CLEAR_ERROR", () => {
    it("sets the error message", () => {
      const state = exerciseReducer(initialExerciseState, {
        type: "SET_ERROR",
        error: "生成失败",
      });
      expect(state.error).toBe("生成失败");
    });

    it("clears the error message", () => {
      const base: ExerciseState = { ...initialExerciseState, error: "生成失败" };
      const state = exerciseReducer(base, { type: "CLEAR_ERROR" });
      expect(state.error).toBeNull();
    });
  });

  describe("SET_SAVE_ERROR", () => {
    it("sets the non-blocking save error", () => {
      const state = exerciseReducer(initialExerciseState, {
        type: "SET_SAVE_ERROR",
        error: "练习结果保存失败",
      });
      expect(state.saveError).toBe("练习结果保存失败");
      // saveError 不影响全局 error
      expect(state.error).toBeNull();
    });
  });

  describe("RESET", () => {
    it("resets all state slots to initial values", () => {
      const base: ExerciseState = {
        exercises,
        userAnswers: ["goes", "He goes home.", ""],
        score: 2,
        error: "err",
        saveError: "save err",
      };
      const state = exerciseReducer(base, { type: "RESET" });
      expect(state).toEqual(initialExerciseState);
    });
  });

  it("returns state unchanged for unknown action type", () => {
    const state = exerciseReducer(initialExerciseState, {
      type: "UNKNOWN",
    } as never);
    expect(state).toBe(initialExerciseState);
  });
});
