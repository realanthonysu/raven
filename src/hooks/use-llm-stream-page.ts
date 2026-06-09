import { useCallback, useState } from "react";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, recordLearningActivity } from "@/lib/db";

export interface UseLLMStreamPageOptions {
  /** 学习打卡的活动类型。 */
  activityType: "writing" | "reading" | "exercise" | "listening";
  /**
   * 根据用户输入构建 LLM 提示消息。
   * 返回 [systemPrompt, userContent] 传递给 streamChat。
   */
  buildMessages: (input: string) => [system: string, user: string];
  /**
   * 流式传输完成、历史记录保存、学习活动记录后调用。
   * 接收完整的流式文本和历史记录 ID（保存失败时为 null）。
   */
  onDone?: (result: string, historyId: number | null) => void;
  /** 自定义错误处理器 —— 在设置 error state 之外额外调用。 */
  onError?: (error: Error) => void;
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
   * 2. 通过 `buildMessages(input)` 构建提示消息
   * 3. 流式接收 LLM 响应，累积 token 到 `result`
   * 4. 通过 `addHistorySafe` 持久化到历史表
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
 * 消除 CorrectPage、ReadingPage、ExercisePage、ListeningPage 中
 * 重复的 ~40 行样板代码：result state 管理、useStreamChat 接入、
 * 历史持久化、学习活动记录。
 *
 * 页面只需提供 `buildMessages`，并可通过 `onDone`、`onError`、
 * `buildHistoryRecord` 进行定制。
 *
 * @example
 * ```tsx
 * const { loading, error, result, handleSubmit } = useLLMStreamPage({
 *   activityType: "writing",
 *   buildMessages: (input) => [PROMPT, input],
 *   onDone: (text) => setParsed(parseCorrectionJson(text)),
 * });
 * ```
 */
export function useLLMStreamPage(options: UseLLMStreamPageOptions): UseLLMStreamPageReturn {
  const {
    activityType,
    buildMessages,
    onDone,
    onError: onErrorCallback,
    buildHistoryRecord,
  } = options;

  const [result, setResult] = useState("");

  const { loading, error, setError, execute, abort } = useStreamChat(activityType);

  // handleSubmit 编排完整的 LLM 流式页面生命周期：
  // 重置状态 → 构建提示 → 流式接收 → 持久化 → 记录活动 → 回调

  const handleSubmit = useCallback(
    async (input: string) => {
      setResult("");
      setError(null);

      const [systemPrompt, userContent] = buildMessages(input);

      await execute(systemPrompt, userContent, {
        onToken: (token) => setResult((prev) => prev + token),
        onDone: async (fullText) => {
          // 1. 持久化到历史表
          const record = buildHistoryRecord
            ? buildHistoryRecord(input, fullText)
            : { type: activityType, input_text: input, result: fullText };

          let historyId: number | null = null;
          if (record) {
            historyId = await addHistorySafe(record);
          }

          // 2. 记录学习活动用于打卡统计
          //    此处统一处理所有 activityType，
          //    确保无论 useStreamChat 是否内部记录，打卡数据都不会遗漏
          recordLearningActivity(activityType).catch(() => {});

          // 3. 执行自定义后处理（如解析 JSON、设置页面状态等）
          onDone?.(fullText, historyId);
        },
        onError: (err) => {
          setError(err.message);
          onErrorCallback?.(err);
        },
      });
    },
    [activityType, buildMessages, buildHistoryRecord, execute, setError, onDone, onErrorCallback],
  );

  return { loading, error, setError, result, setResult, handleSubmit, abort };
}
