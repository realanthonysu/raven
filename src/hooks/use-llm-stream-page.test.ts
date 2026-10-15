import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_KEYS } from "@/lib/task-status";
import { useLLMStreamPage } from "./use-llm-stream-page";

// ─── Module mocks ─────────────────────────────────────────────────

const mockExecute = vi.fn();
const mockAbort = vi.fn();
const mockResolveModel = vi.fn().mockResolvedValue(null);
const mockSetError = vi.fn();
/** useStreamChat 的 loadingRef 镜像：测试用它模拟"流式在途"（修复 2 的守卫输入） */
const mockLoadingRef = { current: false };

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: vi.fn(() => ({
    loading: false,
    error: null,
    setError: mockSetError,
    execute: mockExecute,
    abort: mockAbort,
    resolveModel: (...args: unknown[]) => mockResolveModel(...args),
    loadingRef: mockLoadingRef,
  })),
}));

// persistStream 刻意使用会抛错的原始写入 addHistory（不经 barrel），
// 从子模块路径 mock；写库失败路径靠 mockRejectedValueOnce 驱动
const mockAddHistory = vi.fn().mockResolvedValue({ lastInsertId: 42 });
const mockRecordLearningActivitySafe = vi.fn();

vi.mock("@/lib/db/history", () => ({
  addHistory: (...args: unknown[]) => mockAddHistory(...args),
}));

vi.mock("@/lib/db", () => ({
  recordLearningActivitySafe: (...args: unknown[]) => mockRecordLearningActivitySafe(...args),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("useLLMStreamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadingRef.current = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns initial state with empty result, no error, and not loading", () => {
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["system", input],
      }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBe("");
    expect(typeof result.current.handleSubmit).toBe("function");
    expect(typeof result.current.abort).toBe("function");
    expect(typeof result.current.setError).toBe("function");
    expect(typeof result.current.setResult).toBe("function");
    expect(typeof result.current.resolveModel).toBe("function");
  });

  it("resolveModel delegates to useStreamChat's resolveModel", async () => {
    const model = { id: 1, api_key: "sk-test" };
    mockResolveModel.mockResolvedValueOnce(model);

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "reading",
        buildMessages: (input) => ["sys", input],
      }),
    );

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.resolveModel();
    });

    // ReadingPage 语言检测依赖此透传：tier-2 不做任何包装
    expect(mockResolveModel).toHaveBeenCalled();
    expect(resolved).toBe(model);
  });

  it("handleSubmit calls execute with messages from buildMessages", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("streamed result");
      },
    );

    const buildMessages = vi.fn((input: string): [string, string] => [
      "You are a teacher",
      `Fix: ${input}`,
    ]);

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("Hello world");
    });

    expect(buildMessages).toHaveBeenCalledWith("Hello world");
    expect(mockExecute).toHaveBeenCalledWith(
      "You are a teacher",
      "Fix: Hello world",
      expect.objectContaining({
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("handleSubmit accumulates tokens into result state via onToken", async () => {
    let tokenCb: ((token: string) => void) | undefined;
    mockExecute.mockImplementation(
      async (
        _sys: string,
        _usr: string,
        callbacks: { onToken: (token: string) => void; onDone: (text: string) => void },
      ) => {
        tokenCb = callbacks.onToken;
        callbacks.onToken("Hello");
        callbacks.onToken(" world");
        callbacks.onDone("Hello world");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "reading",
        buildMessages: (input) => ["sys", input],
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("some text");
    });

    expect(result.current.result).toBe("Hello world");
    expect(tokenCb).toBeDefined();
  });

  it("handleSubmit resets result at the start of each call", async () => {
    // First call: streams "first"
    mockExecute.mockImplementationOnce(
      async (
        _sys: string,
        _usr: string,
        callbacks: { onToken: (t: string) => void; onDone: (text: string) => void },
      ) => {
        callbacks.onToken("first");
        callbacks.onDone("first");
      },
    );
    // Second call: streams "second"
    mockExecute.mockImplementationOnce(
      async (
        _sys: string,
        _usr: string,
        callbacks: { onToken: (t: string) => void; onDone: (text: string) => void },
      ) => {
        callbacks.onToken("second");
        callbacks.onDone("second");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("input 1");
    });
    expect(result.current.result).toBe("first");

    await act(async () => {
      await result.current.handleSubmit("input 2");
    });
    // Should have been reset then set to "second"
    expect(result.current.result).toBe("second");
  });

  it("handleSubmit persists history via addHistory with default record", async () => {
    mockExecute.mockImplementation(
      async (
        _sys: string,
        _usr: string,
        callbacks: { onToken: (t: string) => void; onDone: (text: string) => void },
      ) => {
        callbacks.onToken("correction result");
        callbacks.onDone("correction result");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("my essay");
    });

    expect(mockAddHistory).toHaveBeenCalledWith({
      type: "writing",
      input_text: "my essay",
      result: "correction result",
    });
  });

  it("handleSubmit persists history with custom buildHistoryRecord", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("exercise result");
      },
    );

    const buildHistoryRecord = vi.fn((input: string, _result: string) => ({
      type: "exercise" as const,
      input_text: `category: ${input}`,
      result: JSON.stringify({ exercises: [], score: 5 }),
    }));

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        buildHistoryRecord,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("grammar");
    });

    expect(buildHistoryRecord).toHaveBeenCalledWith("grammar", "exercise result");
    expect(mockAddHistory).toHaveBeenCalledWith({
      type: "exercise",
      input_text: "category: grammar",
      result: expect.any(String),
    });
  });

  it("handleSubmit supports async buildMessages", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("result");
      },
    );

    const buildMessages = vi.fn(async (input: string): Promise<[string, string]> => {
      // 模拟异步查询（如 buildPersonalizedContext）
      await new Promise((r) => setTimeout(r, 10));
      return ["personalized prompt", input];
    });

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("my text");
    });

    expect(buildMessages).toHaveBeenCalledWith("my text");
    expect(mockExecute).toHaveBeenCalledWith(
      "personalized prompt",
      "my text",
      expect.objectContaining({
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("handleSubmit surfaces save failure via onHistoryError without blocking the result", async () => {
    // 修复 1：写库失败不再被 addHistorySafe 吞掉——本地消化后经
    // onHistoryError 通知（消息格式与 addHistorySafe 一致），结果照常展示
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAddHistory.mockRejectedValueOnce(new Error("db locked"));
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("result");
      },
    );

    const onHistoryError = vi.fn();
    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        onHistoryError,
        onDone,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("text");
    });

    expect(onHistoryError).toHaveBeenCalledWith("保存失败: db locked");
    // 结果仍以 null historyId 交付调用方，不抛出、不中断展示
    expect(onDone).toHaveBeenCalledWith("result", null);
    // 没有历史记录的会话不计入打卡（幽灵打卡修复）
    expect(mockRecordLearningActivitySafe).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("handleSubmit skips history when buildHistoryRecord returns null", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("some result");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        buildHistoryRecord: () => null,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("test");
    });

    expect(mockAddHistory).not.toHaveBeenCalled();
    // 构建器主动跳过写库 = 没有历史记录：同样不计入打卡。
    // 审计结论：现有调用方（Correct/Reading/Exercise/Listening/Speaking）
    // 无一返回 null，该场景仅存在于契约层
    expect(mockRecordLearningActivitySafe).not.toHaveBeenCalled();
  });

  it("handleSubmit records learning activity for all activity types", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
      },
    );

    // 直接遍历 TASK_KEYS：活动类型清单与任务槽注册表同源（C6），
    // 新增任务槽自动进入本用例，无需再手抄一份
    for (const activityType of TASK_KEYS) {
      const { result } = renderHook(() =>
        useLLMStreamPage({
          activityType,
          buildMessages: (input) => ["sys", input],
        }),
      );

      await act(async () => {
        await result.current.handleSubmit("test input");
      });

      expect(mockRecordLearningActivitySafe).toHaveBeenCalledWith(activityType);
      mockRecordLearningActivitySafe.mockClear();
    }
  });

  it("handleSubmit calls onDone with result text and history ID", async () => {
    mockAddHistory.mockResolvedValue({ lastInsertId: 99 });
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("final text");
      },
    );

    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "reading",
        buildMessages: (input) => ["sys", input],
        onDone,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("article");
    });

    expect(onDone).toHaveBeenCalledWith("final text", 99);
  });

  it("handleSubmit calls onDone with null historyId when save is skipped", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("text");
      },
    );

    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        buildHistoryRecord: () => null,
        onDone,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("input");
    });

    expect(onDone).toHaveBeenCalledWith("text", null);
  });

  it("handleSubmit rejects a duplicate submit while in flight, without clearing state", async () => {
    // 修复 2 回归：守卫必须在任何状态清理之前拦截。旧实现一进来就
    // discardPendingTokens + setResult("")，再被 execute 的 preflight
    // 守卫拒绝——界面先清空再报错，闪烁且误导用户
    mockExecute.mockImplementation(
      async (
        _sys: string,
        _usr: string,
        callbacks: { onToken: (t: string) => void; onDone: (text: string) => void },
      ) => {
        callbacks.onToken("first result");
        callbacks.onDone("first result");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    // 第一次提交正常完成，result 落地
    await act(async () => {
      await result.current.handleSubmit("input 1");
    });
    expect(result.current.result).toBe("first result");

    // 模拟第一次请求仍在流式在途（loadingRef 置位，如 LLM 仍在吐 token）
    mockLoadingRef.current = true;
    mockExecute.mockClear();
    mockSetError.mockClear();

    await act(async () => {
      await result.current.handleSubmit("input 2");
    });

    // 顶部守卫直接拦截：execute 不被调用、result 不清空、
    // 沿用现有在途文案（与 execute preflight 守卫同一句话）
    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.current.result).toBe("first result");
    expect(mockSetError).toHaveBeenCalledWith("请求处理中，请稍候");
  });

  it("handleSubmit sets error and calls onError when stream errors", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onError: (err: Error) => void }) => {
        callbacks.onError(new Error("API failure"));
      },
    );

    // Need to override the mock to return an error state
    const { useStreamChat } = await import("@/hooks/use-stream-chat");
    const mockSetError = vi.fn();
    (useStreamChat as ReturnType<typeof vi.fn>).mockReturnValue({
      loading: false,
      error: null,
      setError: mockSetError,
      execute: mockExecute,
      abort: mockAbort,
      resolveModel: mockResolveModel,
      loadingRef: mockLoadingRef,
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        onError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("test");
    });

    expect(mockSetError).toHaveBeenCalledWith("API failure");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "API failure" }));
  });

  it("abort delegates to useStreamChat abort", () => {
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    act(() => {
      result.current.abort();
    });

    expect(mockAbort).toHaveBeenCalled();
  });

  it("setResult allows manual result state updates", () => {
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    act(() => {
      result.current.setResult("manual value");
    });
    expect(result.current.result).toBe("manual value");

    act(() => {
      result.current.setResult("");
    });
    expect(result.current.result).toBe("");
  });

  it("handleSubmit does not auto-persist when autoPersist is false", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("manual result");
      },
    );

    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "listening",
        buildMessages: (input) => ["sys", input],
        autoPersist: false,
        onDone,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("audio text");
    });

    expect(mockAddHistory).not.toHaveBeenCalled();
    expect(mockRecordLearningActivitySafe).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith("manual result", null);
  });

  it("persistResult persists last stream result when called after handleSubmit with autoPersist: false", async () => {
    mockAddHistory.mockResolvedValue({ lastInsertId: 77 });
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("persisted text");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        autoPersist: false,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("exercise input");
    });

    // autoPersist: false means addHistory should NOT have been called during handleSubmit
    expect(mockAddHistory).not.toHaveBeenCalled();

    // Now manually persist
    let historyId: number | null = null;
    await act(async () => {
      historyId = await result.current.persistResult();
    });

    expect(historyId).toBe(77);
    expect(mockAddHistory).toHaveBeenCalledWith({
      type: "exercise",
      input_text: "exercise input",
      result: "persisted text",
    });
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledWith("exercise");
  });

  it("persistResult retries the write after a failure and records activity exactly once", async () => {
    // 修复 1 回归：写库失败后占位必须释放——否则后续 persistResult()
    // 幂等返回缓存的 null，该次流式结果永久丢失且无法重试
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAddHistory.mockRejectedValueOnce(new Error("disk full"));
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("persisted text");
      },
    );

    const onHistoryError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        autoPersist: false,
        onHistoryError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("exercise input");
    });
    // autoPersist: false —— handleSubmit 期间不写库
    expect(mockAddHistory).not.toHaveBeenCalled();

    // 首次持久化失败：返回 null、通知用户、不记录打卡
    let first: number | null = 99;
    await act(async () => {
      first = await result.current.persistResult();
    });
    expect(first).toBeNull();
    expect(onHistoryError).toHaveBeenCalledWith("保存失败: disk full");
    expect(mockRecordLearningActivitySafe).not.toHaveBeenCalled();

    // 占位已在 promise settle 时释放：重试重新发起写库并成功
    mockAddHistory.mockResolvedValueOnce({ lastInsertId: 88 });
    let second: number | null = null;
    await act(async () => {
      second = await result.current.persistResult();
    });
    expect(second).toBe(88);
    expect(mockAddHistory).toHaveBeenCalledTimes(2);
    // 打卡只在落库成功后发生，恰好一次
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledTimes(1);
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledWith("exercise");
    warnSpy.mockRestore();
  });

  it("persistResult is idempotent: repeated calls write only one history record", async () => {
    mockAddHistory.mockResolvedValue({ lastInsertId: 77 });
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("persisted text");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "exercise",
        buildMessages: (input) => ["sys", input],
        autoPersist: false,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("exercise input");
    });

    // 模拟快速双击：两次并发调用 persistResult
    let first: number | null = null;
    let second: number | null = null;
    await act(async () => {
      [first, second] = await Promise.all([
        result.current.persistResult(),
        result.current.persistResult(),
      ]);
    });

    expect(first).toBe(77);
    expect(second).toBe(77);
    // 只写库一次
    expect(mockAddHistory).toHaveBeenCalledTimes(1);
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledTimes(1);
  });

  it("auto-persist marks the stream as persisted so a later manual persistResult does not duplicate", async () => {
    mockAddHistory.mockResolvedValue({ lastInsertId: 55 });
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("auto persisted");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("essay");
    });

    expect(mockAddHistory).toHaveBeenCalledTimes(1);

    // 自动持久化后再手动调用：幂等返回已保存的 ID，不重复写库
    let historyId: number | null = null;
    await act(async () => {
      historyId = await result.current.persistResult();
    });
    expect(historyId).toBe(55);
    expect(mockAddHistory).toHaveBeenCalledTimes(1);
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledTimes(1);
  });

  it("new handleSubmit clears the previous stream record so old results cannot be re-persisted", async () => {
    mockAddHistory.mockResolvedValue({ lastInsertId: 1 });
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("first");
      },
    );

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        autoPersist: false,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("input one");
    });
    await act(async () => {
      await result.current.persistResult();
    });

    // 新一次流式开始后，旧记录已清空：persistResult 不再返回旧 ID
    mockExecute.mockImplementationOnce(
      async (_sys: string, _usr: string, callbacks: { onToken: (t: string) => void }) => {
        callbacks.onToken("second");
        // 注意：不触发 onDone，模拟流式进行中
      },
    );
    await act(async () => {
      await result.current.handleSubmit("input two");
    });

    let historyId: number | null = 123;
    await act(async () => {
      historyId = await result.current.persistResult();
    });
    expect(historyId).toBeNull();
    expect(mockAddHistory).toHaveBeenCalledTimes(1); // 仍是第一次的那条
  });

  it("swallows errors thrown from onDone without producing unhandled rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("result");
      },
    );

    const onDone = vi.fn(async () => {
      throw new Error("onDone exploded");
    });
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "reading",
        buildMessages: (input) => ["sys", input],
        onDone,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("article");
    });

    expect(onDone).toHaveBeenCalled();
    // 错误被就地捕获并记录，而不是浮动 unhandled rejection
    expect(consoleError).toHaveBeenCalledWith(
      "useLLMStreamPage: onDone 回调执行失败:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("handleSubmit sets error and calls onError when buildMessages throws", async () => {
    const buildError = new Error("Failed to build messages");
    const buildMessages = vi.fn(() => {
      throw buildError;
    });

    // Override useStreamChat mock to capture setError
    const { useStreamChat } = await import("@/hooks/use-stream-chat");
    const mockSetError = vi.fn();
    (useStreamChat as ReturnType<typeof vi.fn>).mockReturnValue({
      loading: false,
      error: null,
      setError: mockSetError,
      execute: mockExecute,
      abort: mockAbort,
      resolveModel: mockResolveModel,
      loadingRef: mockLoadingRef,
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages,
        onError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("test input");
    });

    expect(mockSetError).toHaveBeenCalledWith("构建提示消息失败: Failed to build messages");
    expect(onError).toHaveBeenCalledWith(buildError);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
