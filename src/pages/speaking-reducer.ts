/**
 * @module speaking-reducer
 * @description 口语练习页面的 reducer 与纯函数 —— 从 SpeakingPage 抽取为独立模块。
 *
 * O5: 使用 useReducer 集中管理跟读练习的关联状态。
 * 将 sentences / results / currentIndex / currentTranscription / currentScore
 * 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
 *
 * score（本次练习最终平均分）/ error / saveError 等公共状态与 action
 * 由 practice-reducer-utils 基座统一处理 —— 此前这三个槽位以裸 useState
 * 散落在组件顶部（L1 注释所述的声明顺序约束），现已随基座化消除。
 */

import type { SpeakingScore, SpeakingSentence } from "@/types";
import {
  isPracticeBaseAction,
  type PracticeBaseAction,
  type PracticeBaseState,
  reducePracticeBase,
  replaceAt,
} from "./practice-reducer-utils";

/** 口语练习的关联状态 */
export interface SpeakingState extends PracticeBaseState {
  sentences: SpeakingSentence[];
  results: Array<{ transcription: string; score: SpeakingScore } | null>;
  currentIndex: number;
  currentTranscription: string | null;
  currentScore: SpeakingScore | null;
}

/** 口语练习 reducer 的 action 类型（公共 action 来自基座） */
export type SpeakingAction =
  | PracticeBaseAction
  /** 初始化句子列表并清空逐句结果 */
  | { type: "INIT"; sentences: SpeakingSentence[] }
  /** 切换句子 */
  | { type: "NAVIGATE"; index: number }
  /** 设置当前转写文本（ASR 完成时） */
  | { type: "SET_TRANSCRIPTION"; transcription: string }
  // 问题 3: 显式携带目标 index，避免异步评估期间 currentIndex 变化导致评估结果写入错位。
  // 注意不能沿用旧名 SET_SCORE —— 与基座的数值 SET_SCORE（本次练习总分）同名冲突，
  // isPracticeBaseAction 按 action.type 字符串路由，会让本 action 被误交给基座处理。
  | { type: "SET_SENTENCE_RESULT"; index: number; transcription: string; score: SpeakingScore }
  /** 清除当前句的转写与评分（开始新录音前） */
  | { type: "CLEAR_CURRENT" }
  /** 重试当前句：清除当前字段并将该句结果置回 null */
  | { type: "RETRY_CURRENT" };
// RESET 来自基座（回到 initialSpeakingState，含 score/error/saveError/平均分归零）

/** Speaking reducer 初始状态 */
export const initialSpeakingState: SpeakingState = {
  sentences: [],
  results: [],
  currentIndex: 0,
  currentTranscription: null,
  currentScore: null,
  score: 0,
  error: null,
  saveError: null,
};

/**
 * 口语练习 reducer —— 管理跟读练习的关联状态。
 *
 * 公共 action（SET_SCORE/SET_ERROR/CLEAR_ERROR/CLEAR_ERRORS/SET_SAVE_ERROR/RESET）
 * 委托给 practice-reducer-utils 基座；页面特有 action：
 * INIT（初始化句子）、NAVIGATE（切换句子）、SET_TRANSCRIPTION（设置转写）、
 * SET_SENTENCE_RESULT（写入单句评分结果，使用 action.index 避免异步竞态）、
 * CLEAR_CURRENT（清除当前状态）、RETRY_CURRENT（重试当前句）。
 */
export function speakingReducer(state: SpeakingState, action: SpeakingAction): SpeakingState {
  if (isPracticeBaseAction(action)) {
    return reducePracticeBase(state, action, initialSpeakingState);
  }
  switch (action.type) {
    case "INIT":
      // 展开保留公共槽位：生成成功进入 speaking 时不清 error —— 与旧实现一致，
      // 残留错误横幅由 handleRecord 的 CLEAR_ERROR 在首次录音前清除
      return {
        ...state,
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
    case "SET_SENTENCE_RESULT": {
      // 问题 3: 使用 action.index 而非 state.currentIndex，避免评估期间用户切句导致结果写入错位。
      // 问题 4: 当前展示字段仅在 action.index 等于当前句索引时才覆盖——评估期间用户已切到
      // 新句（NAVIGATE 恢复了该句自身数据），晚到的旧句结果若无条件覆盖会污染新句展示。
      return {
        ...state,
        ...(action.index === state.currentIndex
          ? { currentTranscription: action.transcription, currentScore: action.score }
          : {}),
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
