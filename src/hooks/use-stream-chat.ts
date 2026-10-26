import { useCallback, useEffect, useRef, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { getDefaultModelCached } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { markTaskCompleted, setTaskStatus, type TaskKey } from "@/lib/task-status";
import { buildPrompt, streamChat } from "@/services/llm";
import type { ModelConfig } from "@/types";

/**
 * 模型未配置的规范错误文案 —— 全应用唯一来源。
 * 消费方：本 hook execute 的预检（resolveModelWith）与 use-llm-task 原语的
 * 模型解析（notConfiguredMessage 的默认值）。此前 ReadingPage 曾在提交前
 * 预检中逐字复制过一份，已随 resolveModel 的引入删除。
 */
export const MODEL_NOT_CONFIGURED_MESSAGE = "请先在设置页面配置 LLM 模型。";

/**
 * 在途重复提交的规范提示文案 —— 全站唯一来源。
 * 消费方有两处：本 hook execute 的 preflight 守卫（模型查询 await 窗口内的
 * 重复提交），以及 useLLMStreamPage 的顶部在途守卫（loadingRef 前置拦截）。
 * 两处共用同一句话，避免文案漂移。
 */
export const REQUEST_IN_FLIGHT_MESSAGE = "请求处理中，请稍候";

/**
 * 一次 execute 调用的收尾结果（awaited 契约）。
 *
 * - `completed` — 流式成功完成（调用方 onDone 抛错已由通道消化并记日志，不影响本状态）
 * - `aborted` — 流式阶段被中止（预检期的中止不算：流式从未发起，见 skipped）
 * - `error` — 错误已上屏并回调 onError，message 为同一条错误信息
 * - `skipped` — 未发起流式即返回：重复提交被拒 / 模型缺失 / 预检期被中止
 */
export type StreamOutcome =
  | { status: "completed"; fullText: string }
  | { status: "aborted" }
  | { status: "error"; message: string }
  | { status: "skipped" };

/** execute 的 per-call 回调选项。 */
export interface UseStreamChatOptions {
  /** 收到新 token 时调用，用于实时更新流式文本 */
  onToken?: (token: string) => void;
  /**
   * 流式传输完成时调用，接收完整的响应文本。
   * 可返回 promise——execute 会 await 它 settle 后才 resolve（awaited 契约），
   * 返回的 promise reject 或回调同步抛错由通道消化（记 console.error，
   * 不触发 onError、不让 execute reject），outcome 仍为 completed。
   */
  onDone?: (fullText: string) => void | Promise<void>;
  /** 发生错误时调用 */
  onError?: (error: Error) => void;
  /** 请求被中止时调用 */
  onAbort?: () => void;
}

/**
 * 共享的 LLM 流式调用通道 hook。
 * 封装：模型查询、AbortController 生命周期、任务状态上报。
 *
 * 深模块契约：execute 返回 Promise<StreamOutcome>（awaited 契约）——
 * resolve 时间点覆盖调用方 onDone 的整个异步收尾管线，且承诺永不 reject
 * （一切失败路径都归一为 outcome / setError / onError 回调），调用方无需
 * 再为通道搭防御性 try/catch。
 *
 * @param taskName - 任务槽位标识（TaskKey，见 lib/task-status 的任务槽注册表），
 *   用于更新全局任务状态存储（task-status），Layout 的 TaskStatusBar 据此显示加载/完成状态。
 *
 * @returns
 * - `loading` — 当前是否有 LLM 请求正在进行中
 * - `error` — 最近一次错误信息（无错误时为 null）
 * - `setError` — 手动设置错误信息（如外部校验失败时使用）
 * - `execute` — 发起一次流式 LLM 调用（回调经第三参数 per-call 传入），
 *   返回 Promise<StreamOutcome>，见 awaited 契约说明
 * - `abort` — 取消当前正在进行的请求
 * - `loadingRef` — loading 的 ref 镜像（execute 流式在途为 true），
 *   供调用方在事件回调/闭包中同步读取在途状态做前置守卫
 *   （如 useLLMStreamPage 的 handleSubmit 顶部重复提交拦截），
 *   避免读到尚未 re-render 的旧 loading state
 */
export function useStreamChat(taskName: TaskKey) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();

  // F-13: 跟踪 loading 状态，卸载时仅清除 running 状态，保留 completed 状态。
  // 同步导出为 loadingRef：调用方（如 useLLMStreamPage）需要在 handleSubmit
  // 最顶部、任何状态清理之前同步读到"流式是否在途"，而 loading state 要等
  // re-render 才能反映，ref 镜像没有这个延迟。
  const loadingRef = useRef(false);
  const setLoadingState = useCallback((v: boolean) => {
    loadingRef.current = v;
    setLoading(v);
  }, []);

  // 当前活跃请求的 signal。abort 事件按 DOM 规范以异步任务派发：
  // 快速重新提交时，旧请求的 abort 监听器可能在新请求已置 loading=true 之后才触发，
  // 把新请求的状态误清为 false/idle。监听器内校验 signal 是否仍是当前请求。
  const activeSignalRef = useRef<AbortSignal | null>(null);

  // 预检阶段（模型查询 await 窗口）守卫 —— 通道侧的二道防线：
  // execute 入口到 streamChat 启动之间存在 getDefaultModelCached() 的 await 窗口，
  // 该窗口内重复提交会产生两路并发 streamChat（双倍计费/重复历史记录）。
  // 此时 loadingRef 尚未置位（流式未启动），页面顶部守卫覆盖不到，由本守卫兜住；
  // 仅在预检窗口内忽略重复调用，流式启动后恢复正常语义
  // （重新提交 = abort 旧请求再发起新请求）。页面顶部经 loadingRef 的拦截
  // 属于 useLLMStreamPage 的展示策略（避免"清空→报错"闪烁），与本守卫分工不同。
  const preflightRef = useRef(false);

  /**
   * execute 内部的默认模型预检实现。
   * 成功返回模型配置；被中止或模型缺失/无 Key 时返回 null——
   * 缺失时在此设置规范错误文案（MODEL_NOT_CONFIGURED_MESSAGE，全站唯一来源），
   * 被中止时保持静默（用户取消不算错误，不应触发错误提示）。
   */
  const resolveModelWith = useCallback(
    async (signal: AbortSignal): Promise<ModelConfig | null> => {
      const model = await getDefaultModelCached();
      if (signal.aborted) return null;
      if (!model?.api_key) {
        setError(MODEL_NOT_CONFIGURED_MESSAGE);
        return null;
      }
      return model;
    },
    // setError 是 useState 的 setter（引用稳定），无需列入依赖数组
    [],
  );

  const handleAbort = useCallback(() => {
    abort();
  }, [abort]);

  // 组件卸载时清理：中止进行中的请求，避免任务状态卡在 "running"
  // useAbortable 的 cleanup 会 abort controller 并触发 abort 信号监听器重置状态。
  // 此处额外调用 setTaskStatus(false) 作为安全兜底，确保 "running" 状态一定被清除。
  // F-13: 仅在请求进行中（loading）时清除 running 状态，避免误清已 completed 的状态。
  useEffect(() => {
    return () => {
      abort();
      activeSignalRef.current = null;
      if (loadingRef.current) setTaskStatus(taskName, false);
    };
  }, [taskName, abort]);

  /**
   * 发起一次流式 LLM 调用。
   *
   * @param systemPrompt - 系统提示词
   * @param userContent - 用户输入内容
   * @param overrides - 可选的 per-call 回调（onToken/onDone/onError/onAbort），
   *   仅对本次调用生效；onDone 可返回 promise，会被 await（见 awaited 契约）。
   * @returns 收尾结果 Promise<StreamOutcome>——在调用方 onDone 的异步收尾
   *   （含返回的 promise）settle 之后才 resolve，且承诺永不 reject。
   */
  // resolveModelWith 经 useCallback([]) 引用稳定，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: 稳定引用无需作为依赖
  const execute = useCallback(
    async (
      systemPrompt: string,
      userContent: string,
      overrides?: UseStreamChatOptions,
    ): Promise<StreamOutcome> => {
      // 预检守卫：上一次调用仍在模型查询阶段时忽略重复提交，
      // 避免 await 窗口内产生两路并发 streamChat。
      // 忽略时给出提示（复用 setError），避免重复提交被静默丢弃、用户无感知
      if (preflightRef.current) {
        setError(REQUEST_IN_FLIGHT_MESSAGE);
        return { status: "skipped" };
      }
      preflightRef.current = true;

      const opts = overrides ?? {};

      // onDone 收尾的 deferred promise（awaited 契约核心）：
      // streamChat 不 await 回调，调用方 onDone 的异步收尾管线（如 useLLMStreamPage
      // 的持久化）无法被它等待。这里把「任务状态收尾 + await 调用方 onDone」包成
      // promise 存入局部变量，await streamChat(...) 结束后再补 await——execute 的
      // resolve 时间点因此覆盖整个收尾管线。onDone 为同步函数时该 promise 天然
      // 已 settle，行为与旧版逐字兼容。
      let onDonePromise: Promise<void> | null = null;
      let fullText = "";
      let streamError: Error | null = null;

      try {
        // 中止旧请求并获取新 signal（useAbortable 内部管理 controller 生命周期）
        abort();
        const signal = getSignal();
        // 同步登记新请求身份：旧请求的 abort 事件晚于此触发时会被守卫拦截
        activeSignalRef.current = signal;

        // 模型预检的 IPC 拒绝（db 命令失败/序列化异常等）不得逃逸成 unhandled
        // rejection：转为规范错误上屏并补发 onError。预检窗口内被中止时与
        // 下方 signal.aborted 提前返回对称——只回调 onAbort，不重复触发。
        let model: ModelConfig | null;
        try {
          model = await resolveModelWith(signal);
        } catch (err) {
          if (signal.aborted) {
            if (activeSignalRef.current === signal) opts.onAbort?.();
            return { status: "skipped" };
          }
          const error =
            err instanceof Error ? err : new Error(getErrorMessage(err, "加载模型配置失败"));
          setError(error.message);
          opts.onError?.(error);
          return { status: "error", message: error.message };
        }
        // abort 落在预检 await 窗口内也要回调 onAbort，否则调用方的瞬态忙标志
        // （如 speaking 会话的 evaluating）会永久卡死。守卫与下方 abort 监听器对称：
        // 若期间已有更新的 execute 接管（activeSignalRef 已指向新 signal），
        // 本请求的 onAbort 不触发，避免旧请求复位新请求的状态。
        if (signal.aborted) {
          if (activeSignalRef.current === signal) opts.onAbort?.();
          return { status: "skipped" };
        }
        if (!model) {
          // 模型缺失：规范错误文案已由 resolveModelWith 设置，此处补发 onError 回调
          opts.onError?.(new Error(MODEL_NOT_CONFIGURED_MESSAGE));
          return { status: "skipped" };
        }

        // 预检窗口到此结束：进入流式阶段后恢复"重新提交 = abort 旧请求"的语义
        preflightRef.current = false;

        setLoadingState(true);
        setError(null);
        setTaskStatus(taskName, true);

        signal.addEventListener(
          "abort",
          () => {
            // 竞态守卫：只有"仍是当前请求"时才重置状态。
            // 快速重新提交场景下，本监听器属于已被 abort 的旧 signal，
            // 此时 activeSignalRef 已指向新请求的 signal，直接跳过。
            if (activeSignalRef.current !== signal) return;
            setLoadingState(false);
            setTaskStatus(taskName, false);
            opts.onAbort?.();
          },
          { once: true },
        );

        const messages = buildPrompt(systemPrompt, userContent);

        try {
          await streamChat(
            messages,
            model,
            {
              onToken: (token) => opts.onToken?.(token),
              onDone: (text) => {
                // abort 和 onDone 可能近乎同时触发，跳过已中止的回调
                if (signal.aborted) return;
                setLoadingState(false);
                fullText = text;
                // deferred：markTaskCompleted 在 async 包装体内首个 await 之前
                // 同步执行（时序与旧版一致），onDone 的异步部分由下方补 await
                onDonePromise = (async () => {
                  markTaskCompleted(taskName);
                  // 学习活动记录由上层 useLLMStreamPage 的持久化管线负责
                  // （persistStream 内 recordLearningActivitySafe），本 hook 仅关注
                  // 流式通信和任务状态上报，避免重复记录。
                  await opts.onDone?.(text);
                })();
              },
              onError: (err) => {
                setLoadingState(false);
                setTaskStatus(taskName, false);
                setError(err.message);
                opts.onError?.(err);
                streamError = err;
              },
            },
            signal,
          );
        } catch (err) {
          // streamChat 契约上不 reject（失败经 onError 回调上报、中止静默返回）；
          // 此兜底覆盖未预期异常，语义与 onError 路径一致——execute 承诺永不 reject
          const error = err instanceof Error ? err : new Error(getErrorMessage(err));
          setLoadingState(false);
          setTaskStatus(taskName, false);
          setError(error.message);
          opts.onError?.(error);
          streamError = error;
        }

        // awaited 契约：先等调用方 onDone 的收尾管线 settle 再返回。
        // onDone 同步抛错 / 返回的 promise reject 在此就地消化：记日志、
        // 不让 execute reject、也不触发 onError 二次回调——流式本身已成功，
        // outcome 仍为 completed。
        if (onDonePromise) {
          try {
            await onDonePromise;
          } catch (err) {
            console.error("useStreamChat: onDone 回调执行失败:", err);
          }
          return { status: "completed", fullText };
        }
        if (streamError) return { status: "error", message: streamError.message };
        // 既无 onDone 也无 onError：按 services/llm 的契约只有中止才静默返回，
        // 此处按 aborted 收尾（防御性兜底，正常不可达）
        return { status: "aborted" };
      } finally {
        // 兜底清除守卫，覆盖所有提前返回/抛错路径，避免守卫卡死后续提交
        preflightRef.current = false;
      }
    },
    [taskName, abort, getSignal, setLoadingState],
  );

  return { loading, error, setError, execute, abort: handleAbort, loadingRef };
}
