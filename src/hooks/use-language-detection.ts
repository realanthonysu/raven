/**
 * useLanguageDetection —— 封装语言检测的 LLM 调用和状态管理。
 *
 * ReadingPage 在精读分析前调用此 hook 判断输入是否为英文，
 * 非英文则拦截并提示用户。
 */
import { useCallback, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { extractJsonSafe } from "@/lib/parse-utils";
import { LanguageDetectionSchema } from "@/lib/schemas";
import { DETECT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { LanguageDetection, ModelConfig } from "@/types";

export function useLanguageDetection() {
  const [detecting, setDetecting] = useState(false);
  const { abort, getSignal } = useAbortable();
  // 请求身份守卫：并发检测时，被取代的旧调用不得清零新调用的 detecting
  // （旧调用 catch/成功路径的 setDetecting(false) 曾无条件执行）。与 abort
  // 的分工见 hook 文档。
  const { begin, isStale } = useStaleGuard();

  /**
   * 检测输入文本是否为英文。
   * @returns true = 是英文（可继续分析），false = 非英文，
   *          null = 检测被中止（用户重置/重新提交），调用方应直接放弃本次流程
   */
  const detectLanguage = useCallback(
    async (text: string, model: ModelConfig): Promise<LanguageDetection | null> => {
      // 中止旧请求并获取新 signal（useAbortable 内部管理生命周期）
      abort();
      const signal = getSignal();
      // begin() 之后本调用成为所有者：后续任何检测都会使它过期
      const seq = begin();

      setDetecting(true);

      let detectText: string;
      try {
        // R4: 使用共享的 streamChatAsync，消除重复的 Promise 包装样板
        const messages = buildPrompt(DETECT_PROMPT, text);
        detectText = await streamChatAsync(messages, model, signal);
      } catch {
        // 被更新的检测取代：detecting 归新调用所有，且本流程已被接管，
        // 与中止同语义——返回 null 让调用方放弃
        if (isStale(seq)) return null;
        setDetecting(false);
        // M2: 检测失败时 fail closed，阻止非英文文本进入分析
        // 中止不是失败：返回 null 让调用方放弃本次流程（此前返回 isEnglish:true
        // 会放行并让 handleAnalyze 继续提交旧文本分析,重置操作失效）
        if (signal.aborted) return null;
        return {
          isEnglish: false,
          reason: "语言检测服务暂时不可用，请检查网络后重试",
        };
      }

      // 同上：过期调用不得清零新调用的 detecting，直接放弃本次流程
      if (isStale(seq)) return null;
      setDetecting(false);

      // 中止时不继续:调用方放弃本次流程
      if (signal.aborted) return null;

      // O1: 使用集中管理的 Zod schema 校验语言检测结果
      const detected = extractJsonSafe(detectText, LanguageDetectionSchema);
      if (detected) return detected;
      // M2: 解析失败时 fail closed
      return { isEnglish: false, reason: "语言检测结果解析失败，请重试" };
    },
    [abort, getSignal, begin, isStale],
  );

  /** 取消正在进行的语言检测请求并重置 detecting 状态。 */
  const cancelDetection = useCallback(() => {
    abort();
    setDetecting(false);
  }, [abort]);

  return { detecting, detectLanguage, cancelDetection };
}
