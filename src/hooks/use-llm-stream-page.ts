import { useCallback, useState } from "react";
import { useLatestRef } from "@/hooks/use-latest-ref";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, recordLearningActivitySafe } from "@/lib/db";

export interface UseLLMStreamPageOptions {
  /** 学习打卡的活动类型。 */
  activityType: "writing" | "reading" | "exercise" | "listening" | "speaking";
  /**
   * 根据用户输入构建 LLM 提示消息。
   * 支持同步和异步两种形式——异步形式用于需要先查询数据库的场景
   * （如 buildPersonalizedContext 查询近期错误历史）。
   * 返回 [systemPrompt, userContent] 传递给 streamChat。
   */
  buildMessages:
    | ((input: string) => [system: string, user: string])
    | ((input: string) => Promise<[system: string, user: string]>);
  /**
   * 流式传输完成、历史记录保存、学习活动记录后调用。
   * 接收完整的流式文本和历史记录 ID（保存失败时为 null）。
   */
  onDone?: (result: string, historyId: number | null) => void;
  /** 自定义错误处理器 —— 在设置 error state 之外额外调用。 */
  onError?: (error: Error) => void;
  /**
   * 历史记录保存失败的回调。
   * addHistorySafe 内部已 catch 错误，此回调用于向用户显示警告（不阻塞结果展示）。
   */
  onHistoryError?: (msg: string) => void;
  /**
   * 自定义历史记录构建器。默认为 `{ type: activityType, input_text: input, result }`。
   * 返回 null 可跳过历史保存。
   */
  buildHistoryRecord?: (
    input: string,
    result: string,
  ) => Parameters<typeof addHistorySafe>[0] | null;
}

export interface UseLLMStreamPageReturn {
  /** 是否有 LLM 请求正在进行中 */
  loading: boolean;
  /** 当前错误信息，无错误时为 null */
  error: string | null;
  /** 手动设置错误信息（如外部校验失败时使用） */
  setError: (e: string | null) => void;
  /** 累积的流式结果文本 */
  result: string;
  /** 手动设置结果文本（如清空时使用） */
  setResult: (r: string) => void;
  /**
   * 编排完整的 LLM 流式页面生命周期：
   * 1. 重置 result state
   * 2. 通过 `buildMessages(input)` 构建提示消息（支持异步）
   * 3. 流式接收 LLM 响应，累积 token 到 `result`
   * 4. 通过 `addHistorySafe` 持久化到历史表（失败时调用 onHistoryError）
   * 5. 记录学习活动用于打卡统计
   * 6. 调用 `onDone` 回调
   */
  handleSubmit: (input: string) => Promise<void>;
  /** 中止当前进行中的请求 */
  abort: () => void;
}

/**
 * 模板方法 hook —— 封装 LLM 流式页面的共享生命周期。
 *
 * 消除 CorrectPage、ReadingPage 中重复的 ~30 行样板代码：
 * result state 管理、useStreamChat 接入、历史持久化、学习活动记录。
 *
 * 页面只需提供 `buildMessages`，并可通过 `onDone`、`onError`、
 * `onHistoryError`、`buildHistoryRecord` 进行定制。
 *
 * R6: 使用 useLatestRef 存储 options，使 handleSubmit 不依赖 options 变化。
 * 调用者无需 memoize 回调函数，handleSubmit 始终读取最新的 options。
 *
 * @example
 * ```tsx
 * const { loading, error, result, handleSubmit } = useLLMStreamPage({
 *   activityType: "writing",
 *   buildMessages: async (input) => {
 *     const context = await buildPersonalizedContext();
 *     return [context ? `${PROMPT}\n\n${context}` : PROMPT, input];
 *   },
 *   onHistoryError: (msg) => setSaveError(`保存失败：${msg}`),
 *   onDone: (text) => setParsed(parseCorrectionJson(text)),
 * });
 * ```
 */
export function useLLMStreamPage(options: UseLLMStreamPageOptions): UseLLMStreamPageReturn {
  const { activityType } = options;

  const [result, setResult] = useState("");

  const { loading, error, setError, execute, abort } = useStreamChat(activityType);

  // R6: 将 options 存入 ref，使 handleSubmit 始终读取最新的回调，
  // 而无需将 options 放入依赖数组（避免调用者未 memoize 时 handleSubmit 被反复重建）
  const optionsRef = useLatestRef(options);

  // handleSubmit 编排完整的 LLM 流式页面生命周期：
  // 重置状态 → 构建提示（支持异步） → 流式接收 → 持久化 → 记录活动 → 回调

  // optionsRef.current 通过 useLatestRef 同步，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const handleSubmit = useCallback(
    async (input: string) => {
      const {
        buildMessages,
        onDone,
        onError: onErrorCallback,
        onHistoryError,
        buildHistoryRecord,
      } = optionsRef.current;

      setResult("");
      setError(null);

      const [systemPrompt, userContent] = await buildMessages(input);

      await execute(systemPrompt, userContent, {
        onToken: (token) => setResult((prev) => prev + token),
        onDone: async (fullText) => {
          // 1. 持久化到历史表（失败时通过 onHistoryError 通知，不阻塞结果展示）
          const record = buildHistoryRecord
            ? buildHistoryRecord(input, fullText)
            : { type: activityType, input_text: input, result: fullText };

          let historyId: number | null = null;
          if (record) {
            historyId = await addHistorySafe(record, onHistoryError);
          }

          // 2. 记录学习活动用于打卡统计
          //    此处统一处理所有 activityType，
          //    确保无论 useStreamChat 是否内部记录，打卡数据都不会遗漏。
          //    R9: 使用 recordLearningActivitySafe 非阻断版本
          recordLearningActivitySafe(activityType);

          // 3. 执行自定义后处理（如解析 JSON、设置页面状态等）
          onDone?.(fullText, historyId);
        },
        onError: (err) => {
          setError(err.message);
          onErrorCallback?.(err);
        },
      });
    },
    [activityType, execute, setError],
  );

  return { loading, error, setError, result, setResult, handleSubmit, abort };
}
