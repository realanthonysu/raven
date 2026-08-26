/**
 * @module use-speaking-session
 * @description 口语练习的逐句媒体管线 hook —— 从 SpeakingPage 抽取为独立模块。
 *
 * 拥有「开始/停止录音 → WAV 转换 → ASR 转写 → LLM 发音评估」的完整单句循环：
 * - useRecording 封装 MediaRecorder 麦克风录音
 * - convertToWav + transcribeAudio（@/services/asr，走 Rust 非流式代理）
 * - 专属 useStreamChat("speaking") 通道做逐句发音评估，与页面级生成生命周期独立。
 *   已知且接受的行为：该通道与 useLLMStreamPage 会向 task-status 的 "speaking"
 *   槽位双写状态（先 generation 后 evaluation），本次重构原样保留。
 * - processingRef / asrAbortRef 并发与卸载守卫
 *
 * 页面保留：阶段机、句子生成、TTS 自动播放、错词提取与生词本、完成持久化。
 * 结果与错误通过传入的 speakingReducer dispatch 写回，本 hook 不持有跨句状态。
 */

import type { Dispatch } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecording } from "@/hooks/use-recording";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { getErrorMessage } from "@/lib/error-utils";
import { extractJsonSafe } from "@/lib/parse-utils";
import { SpeakingScoreSchema } from "@/lib/schemas";
import { EVALUATION_PROMPT } from "@/prompts";
import { convertToWav, transcribeAudio } from "@/services/asr";
import type { SpeakingSentence } from "@/types";
import type { SpeakingAction } from "../speaking-reducer";

/** useSpeakingSession 的入参 */
export interface UseSpeakingSessionParams {
  /** 当前会话的句子列表：评估时按 targetIndex 锁定原句，避免切句后引用错位 */
  sentences: SpeakingSentence[];
  /** 当前句索引：停止录音时捕获为目标下标 */
  currentIndex: number;
  /** speakingReducer 的 dispatch：评估结果与管线错误经此写回页面状态 */
  dispatch: Dispatch<SpeakingAction>;
}

/** useSpeakingSession 的返回值 */
export interface UseSpeakingSessionReturn {
  /** 是否正在录音 */
  recording: boolean;
  /** 是否正在 ASR 识别 */
  recognizing: boolean;
  /** 是否正在 LLM 评估发音 */
  evaluating: boolean;
  /** 开始录音（清除当前句状态后启动麦克风） */
  startRecording: () => Promise<void>;
  /** 停止录音并执行 转写 → 评估 全流程（处理中重复调用会被忽略） */
  stopRecording: () => Promise<void>;
  /** 中止进行中的评估流（重开一轮时调用，防止晚到结果污染新会话） */
  abortEvaluation: () => void;
}

/**
 * 口语练习逐句媒体管线 hook。
 *
 * 单句循环：startRecording（清当前句 + 开麦）→ stopRecording
 * （stop 取 Blob → convertToWav → transcribeAudio → executeEvaluation），
 * 结果以 SET_SENTENCE_RESULT 写回 index 锁定的目标句；任何失败路径
 * 以 SET_ERROR 上报且不中断后续录音（processingRef 在 finally 中复位）。
 */
export function useSpeakingSession({
  sentences,
  currentIndex,
  dispatch,
}: UseSpeakingSessionParams): UseSpeakingSessionReturn {
  const { recording, start, stop } = useRecording();

  // 当前句处理状态：识别语音 / 评估发音（媒体管线的瞬态忙标志，
  // 不进 reducer —— 它们不参与阶段切换与渲染 precedence，仅驱动按钮禁用态）
  const [recognizing, setRecognizing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);

  // useStreamChat 专用于逐句发音评估（与页面级生命周期独立）
  const { execute: executeEvaluation, abort: abortEvaluation } = useStreamChat("speaking");

  /** 停止录音 → ASR 转写 → LLM 评估。
   * 使用 processingRef 防止快速双击导致重复 ASR/评估请求。 */
  const processingRef = useRef(false);
  /** ASR 请求的中止控制器：页面卸载时中止未完成的转写请求。
   *  注意：会话重启（handleRestart）只中止评估流，不中止在途 ASR——
   *  晚到的 SET_TRANSCRIPTION 会写入新一轮当前句，属已知可接受行为。 */
  const asrAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => asrAbortRef.current?.abort();
  }, []);

  /** 开始录音：清除上一轮的当前句展示与错误提示，再开麦 */
  const startRecording = useCallback(async () => {
    dispatch({ type: "CLEAR_CURRENT" });
    dispatch({ type: "CLEAR_ERROR" });
    // M4: 捕获录音启动错误，避免未处理 rejection
    try {
      await start();
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: getErrorMessage(err, "无法启动录音") });
    }
  }, [start, dispatch]);

  const stopRecording = useCallback(async () => {
    if (processingRef.current || recognizing || evaluating) return;
    processingRef.current = true;
    // 问题 3: 闭包捕获 targetIndex，避免异步评估期间 currentIndex 变化导致评估结果写入新句子
    const targetIndex = currentIndex;
    try {
      const audioBlob = await stop();
      if (!audioBlob || audioBlob.size === 0) {
        // 极短/空录音必须显式提示：静默 return 时用户点停止后界面毫无反馈
        dispatch({ type: "SET_ERROR", error: "录音太短或没有声音，请重试。" });
        return;
      }

      setRecognizing(true);
      try {
        // 1. 转为 WAV 格式（mimo ASR 仅支持 wav/mp3）
        const wavBlob = await convertToWav(audioBlob);
        // 2. ASR 转写（传入中止信号，页面卸载时取消未完成的请求）
        asrAbortRef.current = new AbortController();
        const transcription = await transcribeAudio(
          wavBlob,
          "en",
          undefined,
          asrAbortRef.current.signal,
        );
        dispatch({ type: "CLEAR_ERROR" });
        dispatch({ type: "SET_TRANSCRIPTION", transcription });

        // 3. LLM 评估 —— 使用 targetIndex 锁定原句，避免切句后引用错位
        const original = sentences[targetIndex].text;
        const evalPrompt = EVALUATION_PROMPT(original, transcription);

        setRecognizing(false);
        setEvaluating(true);
        await executeEvaluation(evalPrompt, "", {
          onDone: (fullText) => {
            // M5: 使用 Zod schema 进行运行时校验
            const score = extractJsonSafe(fullText, SpeakingScoreSchema);
            if (score) {
              dispatch({ type: "SET_SENTENCE_RESULT", index: targetIndex, transcription, score });
            } else {
              dispatch({ type: "SET_ERROR", error: "评估解析失败，请重试该句。" });
            }
            setEvaluating(false);
          },
          onError: (err) => {
            dispatch({ type: "SET_ERROR", error: err.message });
            setEvaluating(false);
          },
          // 重新开始一轮（handleRestart）会 abort 在途评估流；use-stream-chat 的
          // abort 路径只回调 onAbort、不触发 onDone/onError，若不在此复位瞬态忙标志，
          // evaluating 会永久卡 true，新一轮 speaking 阶段的录音按钮被锁死
          onAbort: () => {
            setEvaluating(false);
            setRecognizing(false);
          },
        });
      } catch (err) {
        dispatch({ type: "SET_ERROR", error: getErrorMessage(err, "语音识别失败") });
        setRecognizing(false);
        setEvaluating(false);
      }
    } finally {
      // stop() 抛错也必须复位，否则 processingRef 永久卡 true，录音按钮锁死
      processingRef.current = false;
    }
  }, [recognizing, evaluating, stop, sentences, currentIndex, executeEvaluation, dispatch]);

  return { recording, recognizing, evaluating, startRecording, stopRecording, abortEvaluation };
}
