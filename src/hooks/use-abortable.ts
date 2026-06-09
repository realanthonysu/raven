/**
 * useAbortable —— 可复用的 AbortController 生命周期管理 hook。
 *
 * 消除 6 个自定义 hook（useStreamChat、useGraphData、useAudioPlayer、
 * useReadAloud、useLanguageDetection、usePhaseMachine）中重复的
 * ~10 行 AbortController 样板代码。
 *
 * 所有内部状态存储在 ref 中，hook 本身不会触发重渲染。
 */
import { useCallback, useEffect, useRef } from "react";

export interface UseAbortableReturn {
  /** 中止当前 controller 并清空 ref。 */
  abort: () => void;
  /** 返回当前 signal，如果不存在 controller 则自动创建。 */
  getSignal: () => AbortSignal;
  /**
   * 使用新的 signal 执行异步操作。自动中止之前进行中的操作。
   * 返回操作的解析值，若操作被中止则返回 undefined。
   */
  wrapFetch: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  /** 创建新的 controller（用于中止后重新启动新操作）。 */
  reset: () => void;
}

export function useAbortable(): UseAbortableReturn {
  const controllerRef = useRef<AbortController | null>(null);

  // 组件卸载时中止待处理的操作，防止过期回调更新已卸载组件的 state。
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const getSignal = useCallback((): AbortSignal => {
    if (!controllerRef.current) {
      controllerRef.current = new AbortController();
    }
    return controllerRef.current.signal;
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
  }, []);

  const wrapFetch = useCallback(
    <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
      // 中止之前进行中的操作
      controllerRef.current?.abort();

      const controller = new AbortController();
      controllerRef.current = controller;

      return fn(controller.signal).catch((err) => {
        // 静默捕获 AbortError —— abort() 或组件卸载取消操作时的预期行为。
        // 其他错误重新抛出，避免掩盖真实问题。
        if (err instanceof Error && err.name === "AbortError") {
          return undefined;
        }
        throw err;
      });
    },
    [],
  );

  return { abort, getSignal, wrapFetch, reset };
}
