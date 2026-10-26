/**
 * useLanguageDetection —— 封装语言检测的 LLM 调用和状态管理。
 *
 * ReadingPage 在精读分析前调用此 hook 判断输入是否为英文，
 * 非英文则拦截并提示用户。
 *
 * 单飞管线（useAbortable + useStaleGuard + 模型解析 + 解析校验 + stale 自检）
 * 由 useLlmTask 原语承载——模型解析随之收编进 hook（detectLanguage 不再要求
 * 调用方先 resolveModel），本 hook 只负责 outcome → 返回值的映射。
 */
import { useCallback, useState } from "react";
import { useLlmTask } from "@/hooks/use-llm-task";
import { LanguageDetectionSchema } from "@/lib/schemas";
import { DETECT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { LanguageDetection } from "@/types";

/** 检测服务不可用的 fail-closed 文案（error 与 not-configured 共用，见下）。 */
const DETECTION_UNAVAILABLE_REASON = "语言检测服务暂时不可用，请检查网络后重试";

export function useLanguageDetection() {
  const [detecting, setDetecting] = useState(false);
  const { run: runTask, cancel: cancelTask } = useLlmTask<LanguageDetection>();

  /**
   * 检测输入文本是否为英文。
   * @returns LanguageDetection 对象（isEnglish 字段表示是否英文），
   *          null = 检测被中止（用户重置/重新提交）或被更新的检测取代（superseded），
   *          调用方应直接放弃本次流程
   */
  const detectLanguage = useCallback(
    async (text: string): Promise<LanguageDetection | null> => {
      setDetecting(true);

      const outcome = await runTask({
        // R4: 共享的 streamChatAsync，单步流式调用
        buildText: ({ model, signal }) =>
          streamChatAsync(buildPrompt(DETECT_PROMPT, text), model, signal),
        // O1: 集中管理的 Zod schema 校验由原语的 extractJsonSafe 承载
        schema: LanguageDetectionSchema,
      });

      // 被取代的旧调用不得清零新调用的 detecting：detecting 归新调用所有，
      // 且本流程已被接管——与中止同语义，返回 null 让调用方放弃
      if (outcome.status === "superseded") return null;
      setDetecting(false);

      switch (outcome.status) {
        case "parsed":
          return outcome.data;
        case "parse-failed":
          // M2: 解析失败时 fail closed，阻止非英文文本进入分析
          return { isEnglish: false, reason: "语言检测结果解析失败，请重试" };
        case "error":
          // M2: 检测失败时 fail closed（中止不算失败，已在上方归为 null 通道）
          return { isEnglish: false, reason: DETECTION_UNAVAILABLE_REASON };
        case "not-configured":
          // 模型解析收编进原语后，未配置模型在检测内部报 not-configured。
          // 映射为通道规范文案（原语默认即 MODEL_NOT_CONFIGURED_MESSAGE），
          // 与改造前 ReadingPage 前置 resolveModel 返回 null 时的横幅逐字一致
          return { isEnglish: false, reason: outcome.message };
        case "aborted":
          // 中止不是失败：返回 null 让调用方放弃本次流程（此前返回 isEnglish:true
          // 会放行并让 handleAnalyze 继续提交旧文本分析，重置操作失效）
          return null;
      }
    },
    [runTask],
  );

  /** 取消正在进行的语言检测请求并重置 detecting 状态。 */
  const cancelDetection = useCallback(() => {
    cancelTask();
    setDetecting(false);
  }, [cancelTask]);

  return { detecting, detectLanguage, cancelDetection };
}
