/**
 * usePracticeGeneration —— 练习页共享的"生成"状态包装。
 *
 * Exercise/Listening/Speaking 三页此前各自拷贝同一段样板：
 *   const [isGenerating, setIsGenerating] = useState(false);
 *   const generate = useCallback(async () => {
 *     setIsGenerating(true);
 *     try { await handleSubmit(""); } finally { setIsGenerating(false); }
 *   }, [handleSubmit]);
 *
 * C1: 收敛到本 hook。`isGenerating` 与 useLLMStreamPage 的 loading 语义相同
 *（请求进行中为 true），页面仍可配合 useRetryHint 做 30 秒超时提示。
 */
import { useCallback, useState } from "react";

/**
 * @param handleSubmit - useLLMStreamPage 返回的 handleSubmit（页面以空串触发生成）
 * @returns isGenerating（生成中标志）与 generate（带状态包装的生成函数）
 */
export function usePracticeGeneration(handleSubmit: (input: string) => Promise<void>): {
  isGenerating: boolean;
  generate: () => Promise<void>;
} {
  const [isGenerating, setIsGenerating] = useState(false);

  const generate = useCallback(async () => {
    setIsGenerating(true);
    try {
      await handleSubmit("");
    } finally {
      setIsGenerating(false);
    }
  }, [handleSubmit]);

  return { isGenerating, generate };
}
