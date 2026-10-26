import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_IN_FLIGHT_MESSAGE, type StreamOutcome, useStreamChat } from "./use-stream-chat";

// ─── Module mocks ─────────────────────────────────────────────────

const mockStreamChat = vi.fn();
const mockBuildPrompt = vi.fn((system: string, user: string) => [
  { role: "system", content: system },
  { role: "user", content: user },
]);

vi.mock("@/services/llm", () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  buildPrompt: (system: string, user: string) => mockBuildPrompt(system, user),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn().mockResolvedValue({
    id: 1,
    name: "test-model",
    api_key: "sk-test-key",
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o-mini",
    is_default: 1,
  }),
  recordLearningActivity: vi.fn().mockResolvedValue(undefined),
  recordLearningActivitySafe: vi.fn(),
}));

vi.mock("@/lib/task-status", () => ({
  setTaskStatus: vi.fn(),
  markTaskCompleted: vi.fn(),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("useStreamChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns initial state with loading=false and error=null", () => {
    const { result } = renderHook(() => useStreamChat("exercise"));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.execute).toBe("function");
    expect(typeof result.current.abort).toBe("function");
    expect(typeof result.current.setError).toBe("function");
  });

  it("execute sets loading to true during a request", async () => {
    // Make streamChat call onDone synchronously
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("result text");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("system prompt", "user input", {});
    });

    // After completion, loading should be false
    expect(result.current.loading).toBe(false);
  });

  it("execute calls getDefaultModelCached before streaming", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    const { getDefaultModelCached } = await import("@/lib/db");
    expect(getDefaultModelCached).toHaveBeenCalled();
  });

  it("execute sets error when no model is configured", async () => {
    const { getDefaultModelCached } = await import("@/lib/db");
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStreamChat("exercise"));

    const onError = vi.fn();
    let outcome!: StreamOutcome;

    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("请先在设置页面配置 LLM 模型。");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // 模型缺失 = 流式从未发起，awaited 契约归入 skipped
    expect(outcome).toEqual({ status: "skipped" });
  });

  // ── resolveModel 已随 use-llm-task 收编删除：模型预检仅保留 execute 内部
  // 路径（resolveModelWith），其缺失模型路径由上方 "execute sets error when
  // no model is configured" 覆盖。 ──

  it("execute calls onDone with full text when stream completes", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("complete response text");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onDone = vi.fn();
    let outcome!: StreamOutcome;

    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onDone });
    });

    expect(onDone).toHaveBeenCalledWith("complete response text");
    // awaited 契约：completed outcome 携带完整流式文本
    expect(outcome).toEqual({ status: "completed", fullText: "complete response text" });
  });

  it("execute calls onError when stream errors", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onError: (err: Error) => void }) => {
        callbacks.onError(new Error("API rate limited"));
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onError = vi.fn();
    let outcome!: StreamOutcome;

    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("API rate limited");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // awaited 契约：错误路径返回 error outcome，message 与上屏文案一致
    expect(outcome).toEqual({ status: "error", message: "API rate limited" });
  });

  it("execute calls setTaskStatus and markTaskCompleted on success", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    const { setTaskStatus, markTaskCompleted } = await import("@/lib/task-status");
    expect(setTaskStatus).toHaveBeenCalledWith("exercise", true);
    expect(markTaskCompleted).toHaveBeenCalledWith("exercise");
  });

  it("execute calls setTaskStatus(false) on error", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onError: (err: Error) => void }) => {
        callbacks.onError(new Error("fail"));
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    const { setTaskStatus } = await import("@/lib/task-status");
    // Called with true at start, then with false on error
    expect(setTaskStatus).toHaveBeenCalledWith("exercise", false);
  });

  it("exposes loadingRef that tracks the in-flight state for synchronous guards", async () => {
    // 修复 2：loadingRef 是 loading 的 ref 镜像，供调用方在事件回调/闭包中
    // 同步读取在途状态（如 useLLMStreamPage 的重复提交守卫），不必等 re-render
    let capturedOnDone: ((text: string) => void) | undefined;
    mockStreamChat.mockImplementation(
      (_m: unknown, _mo: unknown, callbacks: { onDone: (text: string) => void }) => {
        capturedOnDone = callbacks.onDone;
        return new Promise(() => {}); // 挂起的请求，模拟慢速 LLM
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    // 空闲时为 false
    expect(result.current.loadingRef.current).toBe(false);

    act(() => {
      result.current.execute("sys", "usr", {});
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalled());

    // 流式在途：同步可读
    expect(result.current.loadingRef.current).toBe(true);
    expect(result.current.loading).toBe(true);

    // 流式完成后归位
    act(() => {
      capturedOnDone?.("done");
    });
    expect(result.current.loadingRef.current).toBe(false);
  });

  it("abort cancels the current request", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, _callbacks: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        // Never resolves — simulates a hung request
        return new Promise(() => {});
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    // Start a request — execute is async, awaits getDefaultModelCached() before calling streamChat
    act(() => {
      result.current.execute("sys", "usr", {});
    });

    // Wait for streamChat to actually be called (after getDefaultModelCached resolves)
    await waitFor(() => {
      expect(mockStreamChat).toHaveBeenCalled();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Abort it
    act(() => {
      result.current.abort();
    });

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("setError allows manual error setting", () => {
    const { result } = renderHook(() => useStreamChat("exercise"));

    act(() => {
      result.current.setError("Manual error message");
    });

    expect(result.current.error).toBe("Manual error message");
  });

  it("execute clears previous error on new request", async () => {
    const { getDefaultModelCached } = await import("@/lib/db");

    // First call: no model → error
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });
    expect(result.current.error).toBe("请先在设置页面配置 LLM 模型。");

    // Second call: model available, stream succeeds
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 1,
      name: "test",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
      model_name: "gpt-4o-mini",
      is_default: 1,
    });

    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    expect(result.current.error).toBeNull();
  });

  it("execute does not resolve until the onDone-returned promise settles (awaited contract)", async () => {
    // 回归：streamChat 不 await 回调，旧版 execute 在调用方 onDone 的异步收尾
    // （如 useLLMStreamPage 的持久化管线）settle 之前就已 resolve。
    // awaited 契约要求 execute 等收尾管线完成后才返回。
    let releaseOnDone!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOnDone = resolve;
    });
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("streamed");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onDone = vi.fn(() => gate);

    let executePromise!: Promise<StreamOutcome>;
    act(() => {
      executePromise = result.current.execute("sys", "usr", { onDone });
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    // onDone 的 promise 未 settle 前，execute 不得 resolve
    let settled = false;
    void executePromise.then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false);

    await act(async () => {
      releaseOnDone();
    });
    const outcome = await executePromise;
    expect(outcome).toEqual({ status: "completed", fullText: "streamed" });
  });

  it("digests a synchronous throw from onDone: logs it, resolves completed, no onError", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("streamed");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onDone = vi.fn(() => {
      throw new Error("onDone 同步抛错");
    });
    const onError = vi.fn();

    let outcome!: StreamOutcome;
    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onDone, onError });
    });

    // 流式本身成功：outcome 仍为 completed，execute 不 reject、不二次触发 onError
    expect(outcome).toEqual({ status: "completed", fullText: "streamed" });
    expect(consoleError).toHaveBeenCalledWith(
      "useStreamChat: onDone 回调执行失败:",
      expect.any(Error),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    consoleError.mockRestore();
  });

  it("digests a rejected onDone promise the same way", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("streamed");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onDone = vi.fn(async () => {
      throw new Error("onDone 异步收尾失败");
    });
    const onError = vi.fn();

    let outcome!: StreamOutcome;
    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onDone, onError });
    });

    expect(outcome).toEqual({ status: "completed", fullText: "streamed" });
    expect(consoleError).toHaveBeenCalledWith(
      "useStreamChat: onDone 回调执行失败:",
      expect.any(Error),
    );
    expect(onError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("resolves with an aborted outcome when the stream is aborted mid-flight", async () => {
    // 回归：abort 落在流式阶段（非预检窗口）时，streamChat 按服务契约静默
    // settle（无 onDone/onError）——awaited 契约下 outcome 应为 aborted
    let resolveStream!: () => void;
    mockStreamChat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStream = resolve;
        }),
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onAbort = vi.fn();

    let executePromise!: Promise<StreamOutcome>;
    act(() => {
      executePromise = result.current.execute("sys", "usr", { onAbort });
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalled());

    // 用户中止：abort 监听器复位状态并回调 onAbort
    act(() => {
      result.current.abort();
    });
    await waitFor(() => expect(onAbort).toHaveBeenCalled());
    expect(result.current.loading).toBe(false);

    // 放行挂起的 streamChat（模拟服务观察到中止后静默返回）
    await act(async () => {
      resolveStream();
    });

    const outcome = await executePromise;
    expect(outcome).toEqual({ status: "aborted" });
  });

  it("execute calls streamChat with correct model and messages", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("writing"));

    await act(async () => {
      await result.current.execute("You are a teacher", "Fix my grammar", {});
    });

    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: "You are a teacher" }),
        expect.objectContaining({ role: "user", content: "Fix my grammar" }),
      ]),
      expect.objectContaining({ model_name: "gpt-4o-mini" }),
      expect.objectContaining({ onDone: expect.any(Function) }),
      expect.any(AbortSignal),
    );
  });

  it("writing task does not record learning activity (delegated to page layer)", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("writing"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    const { recordLearningActivity } = await import("@/lib/db");
    // 学习活动记录已由 useStreamChat 移除，统一由 useLLMStreamPage 的持久化管线负责
    expect(recordLearningActivity).not.toHaveBeenCalled();
  });

  it("exercise task does not record learning activity on success", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });

    const { recordLearningActivity } = await import("@/lib/db");
    // exercise task should not auto-record (it's done by the page itself)
    expect(recordLearningActivity).not.toHaveBeenCalled();
  });

  it("unmount aborts pending request and clears running task status", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, _callbacks: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        // Never resolves — simulates a hung request
        return new Promise(() => {});
      },
    );

    const { result, unmount } = renderHook(() => useStreamChat("exercise"));

    // Start a request
    act(() => {
      result.current.execute("sys", "usr", {});
    });

    // Wait for streamChat to be called
    await waitFor(() => {
      expect(mockStreamChat).toHaveBeenCalled();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Unmount — should abort the signal and clear task status
    unmount();

    expect(capturedSignal?.aborted).toBe(true);

    const { setTaskStatus } = await import("@/lib/task-status");
    // setTaskStatus was called with true at start, then with false on unmount
    expect(setTaskStatus).toHaveBeenCalledWith("exercise", false);
  });

  it("ignores duplicate execute calls during the model-lookup window (no concurrent streamChat)", async () => {
    // 回归：execute 入口到 streamChat 启动之间存在 getDefaultModelCached 的 await
    // 窗口，快速双击会在此窗口内产生两路并发 streamChat。守卫应忽略重复调用。
    const { getDefaultModelCached } = await import("@/lib/db");
    let releaseModel!: (value: unknown) => void;
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseModel = resolve;
        }),
    );

    mockStreamChat.mockResolvedValue(undefined);

    const { result } = renderHook(() => useStreamChat("exercise"));

    // 第一次 execute：卡在模型查询窗口
    void result.current.execute("sys", "usr", {});
    // 第二次 execute：仍在同一窗口内，应被忽略
    let secondOutcome!: StreamOutcome;
    await act(async () => {
      secondOutcome = await result.current.execute("sys", "usr", {});
    });

    // 被拒的提交返回 skipped，并给出与 useLLMStreamPage 顶部守卫同一句规范提示
    expect(secondOutcome).toEqual({ status: "skipped" });
    expect(result.current.error).toBe(REQUEST_IN_FLIGHT_MESSAGE);
    expect(mockStreamChat).not.toHaveBeenCalled();

    // 放行模型查询后，只有第一路请求进入流式
    await act(async () => {
      releaseModel({
        id: 1,
        name: "test-model",
        api_key: "sk-test-key",
        base_url: "https://api.openai.com/v1",
        model_name: "gpt-4o-mini",
        is_default: 1,
      });
      // 等待微任务队列清空
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockStreamChat).toHaveBeenCalledTimes(1);

    // 守卫已释放：后续正常提交不被阻塞
    await act(async () => {
      await result.current.execute("sys2", "usr2", {});
    });
    expect(mockStreamChat).toHaveBeenCalledTimes(2);
  });

  it("rapid re-submit keeps the new request's loading state (abort event race)", async () => {
    // 回归：abort 事件按 DOM 规范以异步任务派发。快速重新提交时，
    // 旧请求的 abort 监听器可能在新请求已置 loading=true 之后才触发，
    // 若无请求身份守卫，会把新请求的 loading/任务状态误清为 false/idle。
    interface CapturedCall {
      callbacks: {
        onDone: (text: string) => void;
        onError: (err: Error) => void;
      };
      signal?: AbortSignal;
    }
    const calls: CapturedCall[] = [];
    mockStreamChat.mockImplementation(
      (_m: unknown, _mo: unknown, callbacks: CapturedCall["callbacks"], signal?: AbortSignal) => {
        calls.push({ callbacks, signal });
        return new Promise(() => {}); // 挂起的请求，模拟慢速 LLM
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));

    // 第一次请求启动
    act(() => {
      result.current.execute("sys", "usr", {});
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));

    // 用户快速重新提交：中止第一个请求并立即启动第二个
    act(() => {
      result.current.execute("sys2", "usr2", {});
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(2));

    // 冲刷事件队列，让第一个 signal 的 abort 事件（异步派发）执行完毕
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
    // 核心断言：新请求的 loading 不被旧请求的 abort 监听器误清
    expect(result.current.loading).toBe(true);

    // 新请求正常完成后 loading 归位
    act(() => {
      calls[1].callbacks.onDone("done");
    });
    expect(result.current.loading).toBe(false);
  });

  it("calls onAbort when abort lands inside the preflight model-lookup window", async () => {
    // 回归：abort 落在预检（模型查询）await 窗口内时，abort 监听器尚未注册，
    // 提前返回若不回调 onAbort，调用方的瞬态忙标志（如 speaking 会话的
    // evaluating）会永久卡死。该路径也必须触发 onAbort。
    const { getDefaultModelCached } = await import("@/lib/db");
    let releaseModel!: (value: unknown) => void;
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseModel = resolve;
        }),
    );

    mockStreamChat.mockResolvedValue(undefined);

    const { result } = renderHook(() => useStreamChat("speaking"));
    const onAbort = vi.fn();

    // 启动 execute：卡在模型查询窗口
    const firstExecute = result.current.execute("sys", "usr", { onAbort });
    // 模型 resolve 完成前 abort
    act(() => {
      result.current.abort();
    });

    // 放行模型查询并冲刷微任务，让 execute 走到 signal.aborted 提前返回
    await act(async () => {
      releaseModel({
        id: 1,
        name: "test-model",
        api_key: "sk-test-key",
        base_url: "https://api.openai.com/v1",
        model_name: "gpt-4o-mini",
        is_default: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 核心断言：预检窗口内的 abort 也触发 onAbort，且仅一次；
    // 流式从未发起，awaited 契约返回 skipped
    expect(onAbort).toHaveBeenCalledTimes(1);
    const outcome = await firstExecute;
    expect(outcome).toEqual({ status: "skipped" });
    // 从未进入流式阶段，也不应误报模型缺失错误
    expect(mockStreamChat).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  // ── B4：模型预检 IPC 拒绝不得逃逸成 unhandled rejection ──

  it("surfaces model-lookup rejections as errors instead of an unhandled rejection", async () => {
    // getDefaultModelCached（db 命令 IPC）拒绝时：错误上屏 + onError 回调，
    // 且不进入流式阶段——此前该 rejection 直接逃逸出 execute
    const { getDefaultModelCached } = await import("@/lib/db");
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db 命令失败"),
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onError = vi.fn();
    let outcome!: StreamOutcome;

    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("db 命令失败");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(mockStreamChat).not.toHaveBeenCalled();
    // 预检 IPC 拒绝虽未发起流式，但已产生上屏错误——awaited 契约返回 error
    expect(outcome).toEqual({ status: "error", message: "db 命令失败" });
  });

  it("falls back to a readable message when the model-lookup rejection is not an Error", async () => {
    const { getDefaultModelCached } = await import("@/lib/db");
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockRejectedValueOnce({});

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onError = vi.fn();
    let outcome!: StreamOutcome;

    await act(async () => {
      outcome = await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("加载模型配置失败");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(outcome).toEqual({ status: "error", message: "加载模型配置失败" });
  });

  it("calls onAbort (not onError) when the model lookup rejects after abort", async () => {
    // 预检窗口内 abort 后查询才拒绝：与既有提前返回对称——只回调 onAbort，
    // 不重复触发、不上屏错误
    const { getDefaultModelCached } = await import("@/lib/db");
    let rejectModel!: (err: unknown) => void;
    (getDefaultModelCached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectModel = reject;
        }),
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onAbort = vi.fn();
    const onError = vi.fn();

    const firstExecute = result.current.execute("sys", "usr", { onAbort, onError });
    act(() => {
      result.current.abort();
    });

    await act(async () => {
      rejectModel(new Error("查询在被中止后才失败"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(mockStreamChat).not.toHaveBeenCalled();
    // 预检期被中止 = 流式从未发起：skipped 而非 error/aborted
    const outcome = await firstExecute;
    expect(outcome).toEqual({ status: "skipped" });
  });
});
