/**
 * @module exercise-reducer
 * @description 弱项训练页面的 reducer —— 从 ExercisePage 抽取为独立模块。
 *
 * useReducer 集中管理弱项训练页面的关联状态（参照 SpeakingPage 的 reducer 模式）。
 * 将 exercises / userAnswers / score / error / saveError
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 *
 * score/error/saveError 等公共状态与 action 由 practice-reducer-utils 基座统一处理。
 */

import type { ExerciseQuestion } from "@/types";
import {
  isPracticeBaseAction,
  type PracticeBaseAction,
  type PracticeBaseState,
  reducePracticeBase,
  replaceAt,
} from "./practice-reducer-utils";

/** ExercisePage 组件内的关联状态 */
export interface ExerciseState extends PracticeBaseState {
  exercises: ExerciseQuestion[]; // LLM 生成的练习题列表
  userAnswers: string[]; // 用户答案，与 exercises 等长，下标一一对应
}

/** ExercisePage reducer 的 action 类型（公共 action 来自基座） */
export type ExerciseAction =
  | PracticeBaseAction
  | { type: "SET_EXERCISES"; exercises: ExerciseQuestion[]; answers: string[] }
  | { type: "SET_ANSWER"; index: number; value: string };

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
 * 公共 action（SET_SCORE/SET_ERROR/CLEAR_ERROR/SET_SAVE_ERROR/RESET）委托给基座。
 */
export function exerciseReducer(state: ExerciseState, action: ExerciseAction): ExerciseState {
  if (isPracticeBaseAction(action)) {
    return reducePracticeBase(state, action, initialExerciseState);
  }
  switch (action.type) {
    case "SET_EXERCISES":
      return {
        ...state,
        exercises: action.exercises,
        userAnswers: action.answers,
      };
    case "SET_ANSWER":
      return { ...state, userAnswers: replaceAt(state.userAnswers, action.index, action.value) };
    default:
      return state;
  }
}
