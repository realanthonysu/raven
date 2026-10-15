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
 * - processingRef / asrAbortRef 并发与卸载守卫；会话重启（abortSession）同时
 *   中止在途 ASR 与评估流，晚到的转写/评估结果被静默丢弃，不污染新会话
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
  /**
   * 中止当前会话（重开一轮时调用）：先中止在途 ASR 转写，再中止评估流。
   * 两者都必须中止——只中止评估流时，晚到的 ASR 结果仍会写入新一轮当前句
   * 并照常发起一次评估（多一次计费）。
   */
  abortSession: () => void;
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
  /**
   * ASR 请求的中止控制器：页面卸载、会话重启（abortSession）时中止未完成的
   * 转写请求。晚到的转写结果经 signal.aborted 检查静默丢弃（SET_TRANSCRIPTION
   * 前与 catch 分支各一道），不会写入新一轮会话，也不会触发多余评估。
   */
  const asrAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => asrAbortRef.current?.abort();
  }, []);

  /**
   * 中止当前会话：先 ASR 后评估。
   * ASR 晚到（invoke 无法取消 Rust 命令，abort 仅放弃结果）时，
   * stopRecording 内的 signal.aborted 检查会丢弃其结果；
   * 评估流的中止经 use-stream-chat 的 onAbort 回调复位 busy 标志。
   */
  const abortSession = useCallback(() => {
    asrAbortRef.current?.abort();
    abortEvaluation();
  }, [abortEvaluation]);

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
      // 本轮 ASR 的中止信号：在控制器创建处捕获（而非完成点读
      // asrAbortRef.current）——完成点读取的是"读取时"的引用，正确性
      // 依赖 processingRef 门禁保证控制器未被下一轮替换的隐式耦合；
      // 捕获本轮 signal 让中止判定只属于本轮请求，与替换时序解耦
      let asrSignal: AbortSignal | null = null;
      try {
        // 1. 转为 WAV 格式（mimo ASR 仅支持 wav/mp3）
        const wavBlob = await convertToWav(audioBlob);
        // 2. ASR 转写（传入中止信号：页面卸载/会话重启时放弃结果）
        asrAbortRef.current = new AbortController();
        asrSignal = asrAbortRef.current.signal;
        const transcription = await transcribeAudio(wavBlob, "en", undefined, asrSignal);
        // 会话已被中止（重开一轮）：静默丢弃晚到的转写——否则
        // SET_TRANSCRIPTION 会写入新一轮当前句，评估也会照常发起
        // （多一次计费）。busy 标志同步复位：recognizing 卡 true 会
        // 锁死新一轮的录音按钮；processingRef 由 finally 复位。
        if (asrSignal.aborted) {
          setRecognizing(false);
          setEvaluating(false);
          return;
        }
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
        // 会话已被中止（重开一轮/卸载）：transcribeAudio 经 guardedInvoke
        // 以 AbortError 拒绝（invoke 无法取消 Rust 命令，abort 在请求完成后
        // 被观察到）。此时静默丢弃，不用"语音识别失败"污染新一轮会话；
        // busy 标志照常复位（finally 兜底 processingRef）。
        const aborted =
          asrSignal?.aborted || (err as { name?: string } | null)?.name === "AbortError";
        if (!aborted) {
          dispatch({ type: "SET_ERROR", error: getErrorMessage(err, "语音识别失败") });
        }
        setRecognizing(false);
        setEvaluating(false);
      }
    } finally {
      // stop() 抛错也必须复位，否则 processingRef 永久卡 true，录音按钮锁死
      processingRef.current = false;
    }
  }, [recognizing, evaluating, stop, sentences, currentIndex, executeEvaluation, dispatch]);

  return { recording, recognizing, evaluating, startRecording, stopRecording, abortSession };
}
