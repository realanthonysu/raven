import { useState, useRef, useCallback, useEffect } from "react";
import { streamChat, buildPrompt } from "@/services/llm";
import { getDefaultModel, recordLearningActivity } from "@/lib/db";
import { setTaskStatus, markTaskCompleted } from "@/lib/task-status";

interface UseStreamChatOptions {
  onToken?: (token: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (error: Error) => void;
  onAbort?: () => void;
}

/**
 * 共享的 LLM 流式调用 hook。
 * 封装：模型查询、AbortController 生命周期、任务状态上报。
 *
 * @param taskName - 任务槽位标识（writing/reading/exercise/listening），
 *   用于更新全局任务状态存储（task-status），Layout 的 TaskStatusBar 据此显示加载/完成状态。
 * @param options - 可选的回调函数集合（onToken/onDone/onError/onAbort），
 *   会在整个 hook 生命周期内生效；可通过 execute 的 overrides 参数按次覆盖。
 *
 * @returns
 * - `loading` — 当前是否有 LLM 请求正在进行中
 * - `error` — 最近一次错误信息（无错误时为 null）
 * - `setError` — 手动设置错误信息（如外部校验失败时使用）
 * - `execute` — 发起一次流式 LLM 调用，支持 per-call 选项覆盖
 * - `abort` — 取消当前正在进行的请求
 * - `abortRef` — 直接访问当前 AbortController 的 ref（高级用法）
 */
export function useStreamChat(
  taskName: "writing" | "reading" | "exercise" | "listening",
  options: UseStreamChatOptions = {}
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Store options in a ref so execute doesn't need options in its dependency array.
  // This prevents execute from being recreated when consumers pass non-memoized options.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 发起一次流式 LLM 调用。
   *
   * @param systemPrompt - 系统提示词
   * @param userContent - 用户输入内容
   * @param overrides - 可选的 per-call 回调覆盖，会与 hook 级别的 options 合并，
   *   overrides 中的回调优先级更高（同名回调会覆盖 hook 级别的）。
   */
  const execute = useCallback(
    async (
      systemPrompt: string,
      userContent: string,
      overrides?: UseStreamChatOptions
    ) => {
      const opts = { ...optionsRef.current, ...overrides };

      const controller = new AbortController();
      const oldController = abortRef.current;
      abortRef.current = controller;
      oldController?.abort();

      const model = await getDefaultModel();
      if (!model?.api_key) {
        const errMsg = "请先在设置页面配置 LLM 模型。";
        setError(errMsg);
        opts.onError?.(new Error(errMsg));
        return;
      }

      setLoading(true);
      setError(null);
      setTaskStatus(taskName, true);

      controller.signal.addEventListener(
        "abort",
        () => {
          setLoading(false);
          setTaskStatus(taskName, false);
          opts.onAbort?.();
        },
        { once: true }
      );

      const messages = buildPrompt(systemPrompt, userContent);

      await streamChat(
        messages,
        model,
        {
          onToken: (token) => opts.onToken?.(token),
          onDone: (fullText) => {
            // abort 和 onDone 可能近乎同时触发，跳过已中止的回调
            if (controller.signal.aborted) return;
            setLoading(false);
            markTaskCompleted(taskName);
            // writing/reading 的 onDone 代表活动完成，记录学习打卡
            if (taskName === "writing" || taskName === "reading") {
              recordLearningActivity(taskName).catch(() => {});
            }
            opts.onDone?.(fullText);
          },
          onError: (err) => {
            setLoading(false);
            setTaskStatus(taskName, false);
            setError(err.message);
            opts.onError?.(err);
          },
        },
        controller.signal
      );
    },
    [taskName]
  );

  return { loading, error, setError, execute, abort, abortRef };
}
