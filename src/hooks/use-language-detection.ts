/**
 * useLanguageDetection —— 封装语言检测的 LLM 调用和状态管理。
 *
 * ReadingPage 在精读分析前调用此 hook 判断输入是否为英文，
 * 非英文则拦截并提示用户。
 */
import { useCallback, useState } from "react";
import { z } from "zod";
import { useAbortable } from "@/hooks/use-abortable";
import { extractJson } from "@/lib/parse-utils";
import { DETECT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { ModelConfig } from "@/types";

// O1: 语言检测结果的 Zod schema，统一使用 Zod 进行运行时校验
const LanguageDetectionSchema = z.object({
  isEnglish: z.boolean(),
  reason: z.string().optional(),
});

export function useLanguageDetection() {
  const [detecting, setDetecting] = useState(false);
  const { abort, getSignal } = useAbortable();

  /**
   * 检测输入文本是否为英文。
   * @returns true = 是英文（可继续分析），false = 非英文
   */
  const detectLanguage = useCallback(
    async (text: string, model: ModelConfig): Promise<{ isEnglish: boolean; reason?: string }> => {
      // 中止旧请求并获取新 signal（useAbortable 内部管理生命周期）
      abort();
      const signal = getSignal();

      setDetecting(true);

      let detectText: string;
      try {
        // R4: 使用共享的 streamChatAsync，消除重复的 Promise 包装样板
        const messages = buildPrompt(DETECT_PROMPT, text);
        detectText = await streamChatAsync(messages, model, signal);
      } catch {
        setDetecting(false);
        // M2: 检测失败时 fail closed，阻止非英文文本进入分析
        // 中止不算失败——返回 isEnglish: true 不阻塞主流程
        if (signal.aborted) return { isEnglish: true };
        return {
          isEnglish: false,
          reason: "语言检测服务暂时不可用，请检查网络后重试",
        };
      }

      setDetecting(false);

      // 中止时不阻塞主流程
      if (signal.aborted) return { isEnglish: true };

      // O1: 使用 Zod schema 校验语言检测结果
      const detected = extractJson<{ isEnglish: boolean; reason?: string }>(
        detectText,
        (d) => LanguageDetectionSchema.safeParse(d).success,
      );
      if (detected) return detected;
      // M2: 解析失败时 fail closed
      return { isEnglish: false, reason: "语言检测结果解析失败，请重试" };
    },
    [abort, getSignal],
  );

  /** 取消正在进行的语言检测请求并重置 detecting 状态。 */
  const cancelDetection = useCallback(() => {
    abort();
    setDetecting(false);
  }, [abort]);

  return { detecting, detectLanguage, cancelDetection };
}
