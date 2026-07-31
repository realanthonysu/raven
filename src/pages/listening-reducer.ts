/**
 * @module listening-reducer
 * @description 听力练习页面的 reducer —— 从 ListeningPage 抽取为独立模块。
 *
 * 使用 useReducer 集中管理听力练习的关联状态（遵循 SpeakingPage 同款模式）。
 * 将 sentences / currentIndex / userInputs / score / error / saveError / showHint
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 *
 * score/error/saveError 等公共状态与 action 由 practice-reducer-utils 基座统一处理。
 */

import type { ListeningSentence } from "@/types";
import {
  isPracticeBaseAction,
  type PracticeBaseAction,
  type PracticeBaseState,
  reducePracticeBase,
  replaceAt,
} from "./practice-reducer-utils";

/** 听力练习的关联状态 */
export interface ListeningState extends PracticeBaseState {
  sentences: ListeningSentence[];
  currentIndex: number;
  userInputs: string[];
  showHint: boolean;
}

/** 听力练习状态的动作类型（公共 action 来自基座） */
export type ListeningAction =
  | PracticeBaseAction
  /** 设置 LLM 生成的句子列表并初始化 userInputs 数组 */
  | { type: "SET_SENTENCES"; sentences: ListeningSentence[] }
  /** 设置当前句子索引 */
  | { type: "SET_CURRENT_INDEX"; index: number }
  /** 更新指定句子索引的用户听写输入 */
  | { type: "SET_USER_INPUT"; index: number; value: string }
  /** 切换中文提示可见性 */
  | { type: "SET_SHOW_HINT"; show: boolean };

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
 * 公共 action（SET_SCORE/SET_ERROR/CLEAR_ERROR/SET_SAVE_ERROR/RESET）委托给基座；
 * 页面特有 action：SET_SENTENCES（初始化句子和输入数组）、SET_CURRENT_INDEX（切换句子）、
 * SET_USER_INPUT（更新听写输入）、SET_SHOW_HINT（提示显隐）。
 */
export function listeningReducer(state: ListeningState, action: ListeningAction): ListeningState {
  if (isPracticeBaseAction(action)) {
    return reducePracticeBase(state, action, initialListeningState);
  }
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
    case "SET_USER_INPUT":
      return { ...state, userInputs: replaceAt(state.userInputs, action.index, action.value) };
    case "SET_SHOW_HINT":
      return { ...state, showHint: action.show };
    default:
      return state;
  }
}
