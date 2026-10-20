import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestRef } from "@/hooks/use-latest-ref";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { recordLearningActivitySafe } from "@/lib/db";
// addHistory 刻意不经 db barrel 导入：本 hook 需要"会抛错"的原始写入来区分
// "写库失败"与"构建器跳过写库"（barrel 只导出吞错版的 addHistorySafe）
import { addHistory } from "@/lib/db/history";
import { getErrorMessage } from "@/lib/error-utils";
import type { LevelCode } from "@/lib/levels";
import type { TaskKey } from "@/lib/task-status";
import type { ModelConfig } from "@/types";

/**
 * 流式 token 的批量 flush 间隔（毫秒）。
 * LLM 流式响应每个 token 都会触发一次 setState，长文本下每秒可达数十次
 * 重渲染（ReactMarkdown 每次都要全文重新解析）。缓冲 token 并按固定间隔
 * 批量 flush，将重渲染频率上限压到 ~20fps，肉眼无感知差异。
 */
const TOKEN_FLUSH_INTERVAL_MS = 50;

/** 最近一次流式调用的记录，供 persistStream() / persistResult() 使用。 */
interface StreamRecord {
  fullText: string;
  input: string;
  /**
   * 进行中/已完成的持久化 promise（去重守卫）：
   * 同一次流式结果只写库一次，并发/重复调用共享同一 promise，
   * 幂等返回已保存的 historyId。写库失败时置回 null 允许重试。
   */
  promise: Promise<number | null> | null;
  /** 持久化成功后的历史记录 id（供幂等查询/调试）。 */
  historyId: number | null;
}

export interface UseLLMStreamPageOptions {
  /** 学习打卡的活动类型（TaskKey，见 lib/task-status 的任务槽注册表）。 */
  activityType: TaskKey;
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
   *
   * 当 `autoPersist` 为 `false` 时，`historyId` 始终为 `null`——
   * 页面需手动调用 `persistResult()` 获取 historyId。
   */
  onDone?: (result: string, historyId: number | null) => void;
  /** 自定义错误处理器 —— 在设置 error state 之外额外调用。 */
  onError?: (error: Error) => void;
  /**
   * 历史记录保存失败的回调。
   * 写库失败由 persistStream 本地消化（不抛出、不阻塞结果展示），
   * 此回调用于向用户显示警告（消息格式与 addHistorySafe 一致）。
   */
  onHistoryError?: (msg: string) => void;
  /**
   * 本次流式练习使用的 CEFR 难度级别（A2..C1，见 lib/levels.ts）。
   * 持久化时写入 history.difficulty_level；返回 null 表示未使用级别（存 null）。
   * buildHistoryRecord 自带 difficulty_level 时以其为准（页面明确指定的优先）。
   *
   * 类型契约：返回值必须是 LevelCode 联合成员 —— 写入侧收紧后，
   * 旧 difficulty 字符串（初级/中级/高级）无法不经显式归一就进入数据库
   * （读取侧 use-level-estimation 的 isLevelCode 兜底只兼容存量旧值）。
   */
  getDifficultyLevel?: () => LevelCode | null;
  /**
   * 自定义历史记录构建器。默认为 `{ type: activityType, input_text: input, result }`。
   * 返回 null 可跳过历史保存（此时不记录学习活动——没有历史记录的会话
   * 不应计入打卡，见 persistStream 内的打卡条件）。
   */
  buildHistoryRecord?: (input: string, result: string) => Parameters<typeof addHistory>[0] | null;
  /**
   * 是否在流式完成后自动持久化到 history 表并记录学习活动。
   * 默认 `true`（向后兼容）。
   *
   * 设为 `false` 时，页面需在合适的时机手动调用 `persistResult()`。
   * 适用于"流式生成 → 用户交互 → 评分 → 持久化"的页面
   * （如 ExercisePage、ListeningPage、SpeakingPage）。
   */
  autoPersist?: boolean;
}

interface UseLLMStreamPageReturn {
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
   * 4. 若 autoPersist !== false：通过 `addHistory` 持久化到历史表
   *    （失败时本地消化并经 onHistoryError 通知，释放占位允许重试）
   * 5. 若 autoPersist !== false 且历史记录落库成功：记录学习活动用于打卡统计
   * 6. 调用 `onDone` 回调
   */
  handleSubmit: (input: string) => Promise<void>;
  /** 中止当前进行中的请求 */
  abort: () => void;
  /**
   * 预检当前默认模型（透传自 useStreamChat）：
   * 成功返回模型配置；未配置/无 Key 时设置规范错误文案并返回 null。
   * 供需要在 handleSubmit 之前拿到模型的页面使用
   * （如 ReadingPage 的语言检测前置步骤），避免页面自行查询并复制错误文案。
   */
  resolveModel: () => Promise<ModelConfig | null>;
  /**
   * 手动持久化流式结果到 history 表并记录学习活动。
   * 仅在 `autoPersist: false` 时使用。
   *
   * 返回历史记录 ID（保存失败时为 null）。
   * 失败时通过 `onHistoryError` 回调通知调用方。
   */
  persistResult: () => Promise<number | null>;
}

/**
 * 模板方法 hook —— 封装 LLM 流式页面的共享生命周期。
 *
 * 消除练习页面中重复的 ~30 行样板代码：
 * result state 管理、useStreamChat 接入、历史持久化、学习活动记录。
 *
 * 页面只需提供 `buildMessages`，并可通过 `onDone`、`onError`、
 * `onHistoryError`、`buildHistoryRecord`、`autoPersist` 进行定制。
 *
 * R6: 使用 useLatestRef 存储 options，使 handleSubmit 不依赖 options 变化。
 * 调用者无需 memoize 回调函数，handleSubmit 始终读取最新的 options。
 *
 * @example
 * ```tsx
 * // 流式完成即持久化（CorrectPage / ReadingPage）
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
 *
 * @example
 * ```tsx
 * // 手动持久化（ExercisePage / ListeningPage / SpeakingPage）
 * const { loading, error, handleSubmit, persistResult } = useLLMStreamPage({
 *   activityType: "exercise",
 *   autoPersist: false,
 *   buildMessages: async (input) => {
 *     const context = await buildPersonalizedContext(10);
 *     return [buildExercisePrompt(category, context), ""];
 *   },
 *   onDone: (text) => { parseAndSetExercises(text); transition("answering"); },
 * });
 * // 用户提交答案后：
 * const historyId = await persistResult();
 * ```
 */
export function useLLMStreamPage(options: UseLLMStreamPageOptions): UseLLMStreamPageReturn {
  const { activityType } = options;

  const [result, setResult] = useState("");

  const { loading, error, setError, execute, abort, resolveModel, loadingRef } =
    useStreamChat(activityType);

  // R6: 将 options 存入 ref，使 handleSubmit 始终读取最新的回调，
  // 而无需将 options 放入依赖数组（避免调用者未 memoize 时 handleSubmit 被反复重建）
  const optionsRef = useLatestRef(options);

  // 存储最近一次流式调用的 fullText 和 input，供 persistResult() 使用。
  // persisted/historyId 用于持久化去重：同一次流式结果只写库一次，
  // 重复调用 persistResult() 幂等返回已保存的 historyId。
  const lastStreamRef = useRef<StreamRecord | null>(null);

  /**
   * 统一的持久化入口（合并自动持久化与手动 persistResult 两段重复逻辑）。
   * 带 settled 守卫：单次流式的结果只持久化一次，重复调用幂等返回缓存 ID。
   */
  // optionsRef.current 通过 useLatestRef 同步，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const persistStream = useCallback(async (): Promise<number | null> => {
    const record = lastStreamRef.current;
    if (!record?.fullText) return null;
    // 进行中/已完成的持久化共享同一 promise：并发调用（如快速双击）
    // 等待同一次写库并拿到相同 historyId，不会产生第二条记录
    if (record.promise) return record.promise;

    const { onHistoryError, buildHistoryRecord, getDifficultyLevel } = optionsRef.current;
    const difficultyLevel = getDifficultyLevel?.() ?? null;
    const builtRecord = buildHistoryRecord
      ? buildHistoryRecord(record.input, record.fullText)
      : { type: activityType, input_text: record.input, result: record.fullText };
    // 页面构建器未自带 difficulty_level 时以 getDifficultyLevel 的返回值为准
    const historyRecord =
      builtRecord === null
        ? null
        : { ...builtRecord, difficulty_level: builtRecord.difficulty_level ?? difficultyLevel };

    const persistPromise = (async () => {
      let historyId: number | null = null;
      if (historyRecord) {
        try {
          // 刻意使用会抛错的 addHistory，而非吞掉一切异常返回 null 的
          // addHistorySafe：后者让"写库失败"与"构建器跳过写库"无法区分——
          // 失败的记录会因占位永不释放而被后续调用幂等返回缓存的 null，
          // 该次流式结果永久丢失（且无法重试）。
          // 失败路径在本地消化：提示用户 + 保持 resolve null 语义，
          // 不向调用方抛出（调用方的收尾管线与 persistResult 照常继续）。
          historyId = (await addHistory(historyRecord)).lastInsertId ?? null;
        } catch (e) {
          // 消息格式与 addHistorySafe 保持一致，页面横幅文案不变
          const msg = `保存失败: ${getErrorMessage(e)}`;
          console.warn(msg);
          onHistoryError?.(msg);
          return null;
        }
      }

      // 记录学习活动用于打卡统计。
      // useLLMStreamPage 是学习活动的唯一记录方（useStreamChat 不记录）。
      // 使用 recordLearningActivitySafe 非阻断版本，失败不影响主流程。
      // 仅当历史记录真正落库（historyId !== null）时才打卡：写库失败的会话
      // 没有历史记录，计入学习活动即"幽灵打卡"（与历史列表数据矛盾）。
      // 写库失败已在上方提前 return，不会到达这里。
      if (historyId !== null) {
        recordLearningActivitySafe(activityType);
      }

      record.historyId = historyId;
      return historyId;
    })();
    record.promise = persistPromise;
    // 失败后释放占位，允许后续重试写库：promise settle 后若本次构建了历史
    // 记录（historyRecord 非空）却以 null 收场，说明写库失败——清空占位
    // （仅当它仍指向本 promise），后续 persistResult() 可重新发起写库。
    // 构建器主动跳过写库（historyRecord 为 null）时维持幂等返回 null。
    void persistPromise.then(
      (id) => {
        if (record.promise === persistPromise && historyRecord !== null && id === null) {
          record.promise = null;
        }
      },
      () => {
        // 防御：写库失败已在本地消化，正常不会 reject；若其他意外抛错
        // （如打卡回调同步抛错）也释放占位，避免后续调用永久拿到失败
        if (record.promise === persistPromise && historyRecord !== null) {
          record.promise = null;
        }
      },
    );
    return persistPromise;
  }, [activityType]);

  // 流式 token 节流缓冲：onToken 只追加缓冲，由定时器批量 flush 到 result state
  const pendingTokensRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 丢弃缓冲中的 token 并取消待执行的 flush 定时器 */
  const discardPendingTokens = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingTokensRef.current = "";
  }, []);

  /** 立即将缓冲中的 token 追加到 result state */
  const flushPendingTokens = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingTokensRef.current) {
      const chunk = pendingTokensRef.current;
      pendingTokensRef.current = "";
      setResult((prev) => prev + chunk);
    }
  }, []);

  // 卸载时清理定时器，避免向已卸载组件 setState
  useEffect(() => discardPendingTokens, [discardPendingTokens]);

  // handleSubmit 编排完整的 LLM 流式页面生命周期：
  // 重置状态 → 构建提示（支持异步） → 流式接收 → 持久化（可选） → 记录活动（可选） → 回调

  // optionsRef.current 通过 useLatestRef 同步，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const handleSubmit = useCallback(
    async (input: string) => {
      const { buildMessages, onDone, onError: onErrorCallback, autoPersist } = optionsRef.current;

      // 在途守卫前置到任何状态清理之前：双击/重复提交时，真正的拒绝点在
      // use-stream-chat execute 的 preflight 守卫——若不清洗就走到那里，
      // 会先把 result 清空、再被拒绝，造成"清空→报错"闪烁并误导用户
      // （以为自己的输入丢了）。顶部用 loadingRef 同步读取在途状态直接拦截，
      // 上一次的结果与错误保持展示。execute 内部的 preflight 守卫保留为
      // 二道防线（覆盖模型查询 await 窗口，彼时 loadingRef 尚未置位）。
      if (loadingRef.current) {
        setError("请求处理中，请稍候");
        return;
      }

      discardPendingTokens();
      // 新一次流式开始前清空上一次的持久化记录，避免旧结果被误持久化
      lastStreamRef.current = null;
      setResult("");
      setError(null);

      let systemPrompt: string;
      let userContent: string;
      try {
        [systemPrompt, userContent] = await buildMessages(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`构建提示消息失败: ${msg}`);
        onErrorCallback?.(err instanceof Error ? err : new Error(msg));
        return;
      }

      // 兜底捕获：execute 内部的未预期 rejection（如模型预检 IPC 拒绝未被
      // use-stream-chat 消化）不得逃逸成 unhandled rejection——经 pages 的
      // generate 包装没有自己的 catch，逃逸后页面既无错误也无加载态
      try {
        await execute(systemPrompt, userContent, {
          // 节流：token 先进缓冲，定时器批量 flush（onDone/onError 时兜底）
          onToken: (token) => {
            pendingTokensRef.current += token;
            if (flushTimerRef.current === null) {
              flushTimerRef.current = setTimeout(flushPendingTokens, TOKEN_FLUSH_INTERVAL_MS);
            }
          },
          onDone: (fullText) => {
            // onDone 可能为 async 且 execute 不会 await 本回调：
            // 同步抛错与返回 promise 的 rejection 都必须就地捕获，避免 unhandled rejection
            const safeOnDone = (historyId: number | null) => {
              try {
                Promise.resolve(onDone?.(fullText, historyId)).catch((err) => {
                  console.error("useLLMStreamPage: onDone 回调执行失败:", err);
                });
              } catch (err) {
                console.error("useLLMStreamPage: onDone 回调执行失败:", err);
              }
            };
            // 整个收尾管线放入异步 IIFE 并统一 catch：
            // execute 不会 await 本回调，裸 async 抛错会成为浮动 unhandled rejection
            void (async () => {
              // 丢弃缓冲，直接以完整文本落地，保证 result 与 fullText 严格一致
              discardPendingTokens();
              setResult(fullText);

              // 存储供 persistResult() 使用（持久化守卫初始为 null）
              lastStreamRef.current = { fullText, input, promise: null, historyId: null };

              if (autoPersist === false) {
                // 手动持久化模式：跳过自动持久化，直接回调（页面稍后调 persistResult()）
                safeOnDone(null);
                return;
              }

              // 自动持久化模式（默认行为）：持久化 + 记录学习活动（内部带去重守卫）
              const historyId = await persistStream();

              // 执行自定义后处理（如解析 JSON、设置页面状态等）
              safeOnDone(historyId);
            })().catch((err) => {
              console.error("useLLMStreamPage: 流式完成收尾管线失败:", err);
            });
          },
          onError: (err) => {
            // 保留已接收的部分文本再报错
            flushPendingTokens();
            setError(err.message);
            onErrorCallback?.(err);
          },
        });
      } catch (err) {
        flushPendingTokens();
        const error = err instanceof Error ? err : new Error(getErrorMessage(err));
        setError(error.message);
        onErrorCallback?.(error);
      }
    },
    [
      activityType,
      execute,
      setError,
      flushPendingTokens,
      discardPendingTokens,
      persistStream,
      loadingRef,
    ],
  );

  // 中止请求时同时丢弃缓冲，避免 reset 后残留 token 被 flush 出来
  const abortStream = useCallback(() => {
    discardPendingTokens();
    abort();
  }, [abort, discardPendingTokens]);

  // 手动持久化：委托给 persistStream（与自动持久化共享去重守卫，
  // 重复调用幂等返回已保存的 historyId，不会写重复记录）
  const persistResult = useCallback((): Promise<number | null> => persistStream(), [persistStream]);

  return {
    loading,
    error,
    setError,
    result,
    setResult,
    handleSubmit,
    abort: abortStream,
    persistResult,
    resolveModel,
  };
}
