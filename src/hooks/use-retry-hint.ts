import { useEffect, useState } from "react";

/**
 * useRetryHint —— 加载超时提示 hook。
 *
 * 当加载时间超过指定阈值（默认 30 秒）时，设置 showRetryHint 为 true，
 * 提示用户"生成时间较长，可重新生成"。
 *
 * 用法：
 * ```tsx
 * const { showRetryHint, reset, start } = useRetryHint("loading", 30_000);
 * // phase 为 "loading" 时自动开始计时，离开时自动清除
 * ```
 *
 * 消除 ExercisePage 和 ListeningPage 中重复的 setTimeout + showRetryHint 样板代码。
 *
 * @param isActive - 是否处于需要计时的加载状态
 * @param timeoutMs - 超时阈值（毫秒），默认 30000
 */
export function useRetryHint(isActive: boolean, timeoutMs = 30_000) {
  const [showRetryHint, setShowRetryHint] = useState(false);

  useEffect(() => {
    if (!isActive) {
      setShowRetryHint(false);
      return;
    }
    const timer = setTimeout(() => setShowRetryHint(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [isActive, timeoutMs]);

  return { showRetryHint, reset: () => setShowRetryHint(false) };
}
