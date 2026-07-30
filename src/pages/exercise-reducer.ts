/**
 * @module exercise-reducer
 * @description 弱项训练页面的 reducer —— 从 ExercisePage 抽取为独立模块。
 *
 * useReducer 集中管理弱项训练页面的关联状态（参照 SpeakingPage 的 reducer 模式）。
 * 将 exercises / userAnswers / score / error / saveError
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 */

import type { ExerciseQuestion } from "@/types";

/** ExercisePage 组件内的关联状态 */
export interface ExerciseState {
  exercises: ExerciseQuestion[]; // LLM 生成的练习题列表
  userAnswers: string[]; // 用户答案，与 exercises 等长，下标一一对应
  score: number; // 本次得分（review 阶段由 handleSubmit 设置）
  error: string | null; // 全局错误提示（模型未配置、生成失败等）
  saveError: string | null; // history 表写入失败时的警告信息
}

/** ExercisePage reducer 的 action 类型 */
export type ExerciseAction =
  | { type: "SET_EXERCISES"; exercises: ExerciseQuestion[]; answers: string[] }
  | { type: "SET_ANSWER"; index: number; value: string }
  | { type: "SET_SCORE"; score: number }
  | { type: "SET_ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SET_SAVE_ERROR"; message: string }
  | { type: "RESET" };

/** Exercise reducer 初始状态 */
export const initialExerciseState: ExerciseState = {
  exercises: [],
  userAnswers: [],
  score: 0,
  error: null,
  saveError: null,
};

/**
 * Exercise reducer — 集中处理所有关联状态变更。
 * 参照 SpeakingPage 的 speakingReducer 模式。
 */
export function exerciseReducer(state: ExerciseState, action: ExerciseAction): ExerciseState {
  switch (action.type) {
    case "SET_EXERCISES":
      return {
        ...state,
        exercises: action.exercises,
        userAnswers: action.answers,
      };
    case "SET_ANSWER": {
      const next = [...state.userAnswers];
      next[action.index] = action.value;
      return { ...state, userAnswers: next };
    }
    case "SET_SCORE":
      return { ...state, score: action.score };
    case "SET_ERROR":
      return { ...state, error: action.message };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SAVE_ERROR":
      return { ...state, saveError: action.message };
    case "RESET":
      return initialExerciseState;
    default:
      return state;
  }
}
