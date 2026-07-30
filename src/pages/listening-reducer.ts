/**
 * @module listening-reducer
 * @description 听力练习页面的 reducer —— 从 ListeningPage 抽取为独立模块。
 *
 * 使用 useReducer 集中管理听力练习的关联状态（遵循 SpeakingPage 同款模式）。
 * 将 sentences / currentIndex / userInputs / score / error / saveError / showHint
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 */

import type { ListeningSentence } from "@/types";

/** 听力练习的关联状态 */
export interface ListeningState {
  sentences: ListeningSentence[];
  currentIndex: number;
  userInputs: string[];
  score: number;
  error: string | null;
  /** 历史记录保存失败的非阻断提示（ExercisePage/SpeakingPage 同款模式） */
  saveError: string | null;
  showHint: boolean;
}

/** 听力练习状态的动作类型 */
export type ListeningAction =
  /** 设置 LLM 生成的句子列表并初始化 userInputs 数组 */
  | { type: "SET_SENTENCES"; sentences: ListeningSentence[] }
  /** 设置当前句子索引 */
  | { type: "SET_CURRENT_INDEX"; index: number }
  /** 更新指定句子索引的用户听写输入 */
  | { type: "SET_USER_INPUT"; index: number; value: string }
  /** 设置听写正确句数 */
  | { type: "SET_SCORE"; score: number }
  /** 设置错误信息 */
  | { type: "SET_ERROR"; error: string | null }
  /** 清除错误信息 */
  | { type: "CLEAR_ERROR" }
  /** 设置持久化失败的非阻断提示 */
  | { type: "SET_SAVE_ERROR"; error: string | null }
  /** 切换中文提示可见性 */
  | { type: "SET_SHOW_HINT"; show: boolean }
  /** 重置所有状态到初始值 */
  | { type: "RESET" };

/** Listening reducer 初始状态 */
export const initialListeningState: ListeningState = {
  sentences: [],
  currentIndex: 0,
  userInputs: [],
  score: 0,
  error: null,
  saveError: null,
  showHint: false,
};

/**
 * 听力练习 reducer —— 管理听力练习的关联状态。
 *
 * 9 种 action：SET_SENTENCES（初始化句子和输入数组）、SET_CURRENT_INDEX（切换句子）、
 * SET_USER_INPUT（更新听写输入）、SET_SCORE（设置得分）、SET_ERROR/CLEAR_ERROR（错误管理）、
 * SET_SAVE_ERROR（持久化失败提示）、SET_SHOW_HINT（提示显隐）、RESET（重置所有状态）。
 */
export function listeningReducer(state: ListeningState, action: ListeningAction): ListeningState {
  switch (action.type) {
    case "SET_SENTENCES":
      return {
        ...state,
        sentences: action.sentences,
        userInputs: new Array(action.sentences.length).fill(""),
        currentIndex: 0,
      };
    case "SET_CURRENT_INDEX":
      return { ...state, currentIndex: action.index };
    case "SET_USER_INPUT": {
      const next = [...state.userInputs];
      next[action.index] = action.value;
      return { ...state, userInputs: next };
    }
    case "SET_SCORE":
      return { ...state, score: action.score };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SAVE_ERROR":
      return { ...state, saveError: action.error };
    case "SET_SHOW_HINT":
      return { ...state, showHint: action.show };
    case "RESET":
      return initialListeningState;
    default:
      return state;
  }
}
