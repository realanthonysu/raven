/**
 * @module speaking-reducer
 * @description 口语练习页面的 reducer 与纯函数 —— 从 SpeakingPage 抽取为独立模块。
 *
 * O5: 使用 useReducer 集中管理跟读练习的关联状态。
 * 将 sentences / results / currentIndex / currentTranscription / currentScore
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 */

import type { SpeakingScore, SpeakingSentence } from "@/types";
import { replaceAt } from "./practice-reducer-utils";

export interface SpeakingState {
  sentences: SpeakingSentence[];
  results: Array<{ transcription: string; score: SpeakingScore } | null>;
  currentIndex: number;
  currentTranscription: string | null;
  currentScore: SpeakingScore | null;
}

export type SpeakingAction =
  | { type: "INIT"; sentences: SpeakingSentence[] }
  | { type: "NAVIGATE"; index: number }
  | { type: "SET_TRANSCRIPTION"; transcription: string }
  // 问题 3: SET_SCORE 显式携带目标 index，避免异步回调期间 currentIndex 变化导致评估结果写入错位
  | { type: "SET_SCORE"; index: number; transcription: string; score: SpeakingScore }
  | { type: "CLEAR_CURRENT" }
  | { type: "RETRY_CURRENT" }
  | { type: "RESET" };

/** Speaking reducer 初始状态 */
export const initialSpeakingState: SpeakingState = {
  sentences: [],
  results: [],
  currentIndex: 0,
  currentTranscription: null,
  currentScore: null,
};

/**
 * 口语练习 reducer —— 管理跟读练习的关联状态。
 *
 * 7 种 action：INIT（初始化句子）、NAVIGATE（切换句子）、SET_TRANSCRIPTION（设置转写）、
 * SET_SCORE（写入评分，使用 action.index 避免异步竞态）、CLEAR_CURRENT（清除当前状态）、
 * RETRY_CURRENT（重试当前句）、RESET（重置所有状态）。
 */
export function speakingReducer(state: SpeakingState, action: SpeakingAction): SpeakingState {
  switch (action.type) {
    case "INIT":
      return {
        sentences: action.sentences,
        results: new Array(action.sentences.length).fill(null),
        currentIndex: 0,
        currentTranscription: null,
        currentScore: null,
      };
    case "NAVIGATE": {
      const existing = state.results[action.index];
      return {
        ...state,
        currentIndex: action.index,
        currentTranscription: existing?.transcription ?? null,
        currentScore: existing?.score ?? null,
      };
    }
    case "SET_TRANSCRIPTION":
      return { ...state, currentTranscription: action.transcription };
    case "SET_SCORE": {
      // 问题 3: 使用 action.index 而非 state.currentIndex，避免评估期间用户切句导致结果写入错位
      return {
        ...state,
        currentTranscription: action.transcription,
        currentScore: action.score,
        results: replaceAt(state.results, action.index, {
          transcription: action.transcription,
          score: action.score,
        }),
      };
    }
    case "CLEAR_CURRENT":
      return { ...state, currentTranscription: null, currentScore: null };
    case "RETRY_CURRENT": {
      return {
        ...state,
        currentTranscription: null,
        currentScore: null,
        results: replaceAt(state.results, state.currentIndex, null),
      };
    }
    case "RESET":
      return initialSpeakingState;
    default:
      return state;
  }
}

/**
 * 从原句与 ASR 转写的差异中提取漏读/错读单词。
 * 仅保留原句中存在、但转写文本中未出现的词（忽略大小写与标点）。
 *
 * @param sentences 练习句子列表
 * @param results 每句的评估结果（null 表示未完成）
 * @returns 漏读/错读的单词列表（去重）
 */
export function extractMissedWords(
  sentences: SpeakingSentence[],
  results: Array<{ transcription: string; score: SpeakingScore } | null>,
): string[] {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?;:'"()[\]{}—–-]/g, "")
      .trim();
  const missed = new Set<string>();
  for (let i = 0; i < sentences.length; i++) {
    const r = results[i];
    if (!r?.transcription) continue;
    if ((r.score?.pronunciation ?? 0) >= 80) continue;
    const originalWords = normalize(sentences[i].text).split(/\s+/).filter(Boolean);
    const transWords = new Set(normalize(r.transcription).split(/\s+/).filter(Boolean));
    for (const word of originalWords) {
      if (!transWords.has(word)) {
        missed.add(word);
      }
    }
  }
  return Array.from(missed);
}
