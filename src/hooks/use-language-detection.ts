/**
 * useLanguageDetection —— 封装语言检测的 LLM 调用和状态管理。
 *
 * ReadingPage 在精读分析前调用此 hook 判断输入是否为英文，
 * 非英文则拦截并提示用户。
 */
import { useCallback, useRef, useState } from "react";
import { extractJson } from "@/lib/parse-utils";
import { DETECT_PROMPT } from "@/prompts";
import { buildPrompt, streamChat } from "@/services/llm";
import type { ModelConfig } from "@/types";

export function useLanguageDetection() {
  const [detecting, setDetecting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 检测输入文本是否为英文。
   * @returns true = 是英文（可继续分析），false = 非英文
   */
  const detectLanguage = useCallback(
    async (text: string, model: ModelConfig): Promise<{ isEnglish: boolean; reason?: string }> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setDetecting(true);
      let detectText = "";

      try {
        const messages = buildPrompt(DETECT_PROMPT, text);
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => resolve();
          controller.signal.addEventListener("abort", onAbort, { once: true });
          streamChat(
            messages,
            model,
            {
              onToken: (token) => {
                detectText += token;
              },
              onDone: () => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve();
              },
              onError: (err) => {
                controller.signal.removeEventListener("abort", onAbort);
                reject(err);
              },
            },
            controller.signal,
          );
        });
      } catch {
        setDetecting(false);
        return { isEnglish: true }; // 检测失败时不阻塞，假定是英文
      }

      setDetecting(false);
      const detected = extractJson<{ isEnglish: boolean; reason?: string }>(detectText);
      return detected ?? { isEnglish: true };
    },
    [],
  );

  const cancelDetection = useCallback(() => {
    abortRef.current?.abort();
    setDetecting(false);
  }, []);

  return { detecting, detectLanguage, cancelDetection };
}
