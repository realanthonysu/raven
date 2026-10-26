/**
 * useLLMStreamPage hook tests.
 *
 * mock 策略：不再 mock 通道 hook（@/hooks/use-stream-chat），而是 mock
 * services/llm 的 streamChat，驱动真实通道（use-stream-chat + use-llm-stream-page
 * 一起跑），测试断言落在页面可见行为（result/error/onDone/persistResult）上。
 * - @/services/llm：streamChat 替换为受控 mock（由用例触发 onToken/onDone/onError）；
 *   buildPrompt 保持真实——buildMessages 的产物经真实 buildPrompt 进入 streamChat
 * - @/lib/db：getDefaultModelCached 返回固定模型（通道预检依赖），写路径
 *   recordLearningActivitySafe 替换为 vi.fn()
 * - @/lib/db/history：addHistory 替换为会抛错 mock（persistStream 刻意使用
 *   会抛错的原始写入、不经 barrel，写库失败路径靠 mockRejectedValueOnce 驱动）
 * - @/lib/task-status：setTaskStatus/markTaskCompleted 替换为 vi.fn()，
 *   其余导出（含测试自身引用的 TASK_KEYS）保持真实
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_KEYS } from "@/lib/task-status";
import { useLLMStreamPage } from "./use-llm-stream-page";
import { REQUEST_IN_FLIGHT_MESSAGE } from "./use-stream-chat";

// ─── Module mocks ─────────────────────────────────────────────────

/** streamChat mock 收到的回调形状（与 services/llm 的 StreamCallbacks 对齐） */
interface DrivenCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

const mockStreamChat = vi.fn();

vi.mock("@/services/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/llm")>()),
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
}));

const mockGetDefaultModelCached = vi.fn();
const mockRecordLearningActivitySafe = vi.fn();

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: (...args: unknown[]) => mockGetDefaultModelCached(...args),
  recordLearningActivitySafe: (...args: unknown[]) => mockRecordLearningActivitySafe(...args),
}));

const mockAddHistory = vi.fn();

vi.mock("@/lib/db/history", () => ({
  addHistory: (...args: unknown[]) => mockAddHistory(...args),
}));

vi.mock("@/lib/task-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-status")>()),
  setTaskStatus: vi.fn(),
  markTaskCompleted: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────

/** 让 streamChat mock 立即按"流式成功"收尾：可选先吐 token，再 onDone */
function streamCompletesWith(fullText: string, tokens: string[] = []) {
  mockStreamChat.mockImplementation(
    (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
      for (const token of tokens) callbacks.onToken(token);
      callbacks.onDone(fullText);
      return Promise.resolve();
    },
  );
}

/** 让 streamChat mock 挂起并捕获回调，模拟慢速/在途 LLM */
function streamHangs() {
  let captured: DrivenCallbacks | null = null;
  mockStreamChat.mockImplementation(
    (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
      captured = callbacks;
      return new Promise<void>(() => {});
    },
  );
  return {
    get callbacks(): DrivenCallbacks {
      if (!captured) throw new Error("streamChat 尚未被调用");
      return captured;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("useLLMStreamPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // 通道预检依赖：默认返回带 Key 的模型；单测内用 mockResolvedValueOnce 覆盖
    mockGetDefaultModelCached.mockResolvedValue({
      id: 1,
      name: "test-model",
      api_key: "sk-test-key",
      base_url: "https://api.openai.com/v1",
      model_name: "gpt-4o-mini",
      is_default: 1,
    });
    // 默认写库成功（lastInsertId 42）；单测内用 mockResolvedValueOnce/mockRejectedValueOnce 覆盖
    mockAddHistory.mockResolvedValue({ lastInsertId: 42 });
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
  });

  it("handleSubmit sends buildMessages output through buildPrompt to streamChat", async () => {
    streamCompletesWith("streamed result");

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
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [messages, model, callbacks] = mockStreamChat.mock.calls[0];
    // buildPrompt 保持真实：[system, user] 二元组被原样映射为消息数组
    expect(messages).toEqual([
      { role: "system", content: "You are a teacher" },
      { role: "user", content: "Fix: Hello world" },
    ]);
    // 通道预检拿到的默认模型被透传给 streamChat
    expect(model).toEqual(expect.objectContaining({ api_key: "sk-test-key" }));
    expect(callbacks).toEqual(
      expect.objectContaining({
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("handleSubmit accumulates tokens into result state via onToken", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
        callbacks.onToken("Hello");
        callbacks.onToken(" world");
        callbacks.onDone("Hello world");
        return Promise.resolve();
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
  });

  it("handleSubmit resets result at the start of each call", async () => {
    // First call: streams "first"
    mockStreamChat.mockImplementationOnce(
      (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
        callbacks.onToken("first");
        callbacks.onDone("first");
        return Promise.resolve();
      },
    );
    // Second call: streams "second"
    mockStreamChat.mockImplementationOnce(
      (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
        callbacks.onToken("second");
        callbacks.onDone("second");
        return Promise.resolve();
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
    streamCompletesWith("correction result", ["correction result"]);

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
      difficulty_level: null,
    });
  });

  it("handleSubmit persists history with custom buildHistoryRecord", async () => {
    streamCompletesWith("exercise result");

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
      difficulty_level: null,
    });
  });

  it("handleSubmit supports async buildMessages", async () => {
    streamCompletesWith("result");

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
    const [messages] = mockStreamChat.mock.calls[0];
    expect(messages).toEqual([
      { role: "system", content: "personalized prompt" },
      { role: "user", content: "my text" },
    ]);
  });

  it("handleSubmit surfaces save failure via onHistoryError without blocking the result", async () => {
    // 修复 1：写库失败不再被 addHistorySafe 吞掉——本地消化后经
    // onHistoryError 通知（消息格式与 addHistorySafe 一致），结果照常展示
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAddHistory.mockRejectedValueOnce(new Error("db locked"));
    streamCompletesWith("result");

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
    streamCompletesWith("some result");

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
    streamCompletesWith("ok");

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
    streamCompletesWith("final text");

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
    streamCompletesWith("text");

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
    // discardPendingTokens + setResult("")，再被拒绝——界面先清空再报错，
    // 闪烁且误导用户。真实通道在途（streamChat 挂起）时 loadingRef 已置位。
    const stream = streamHangs();

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    // 第一次提交：真实进入流式在途
    act(() => {
      void result.current.handleSubmit("input 1");
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));

    // 让首提交的 token 落地（等 flush 定时器），使"上一次结果保持展示"可被断言
    await act(async () => {
      stream.callbacks.onToken("first result");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(result.current.result).toBe("first result");

    // 在途时的第二次提交：顶部守卫直接拦截，不发起新流式、不清空结果
    await act(async () => {
      await result.current.handleSubmit("input 2");
    });

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    expect(result.current.result).toBe("first result");
    // 文案与通道 preflight 守卫同源（REQUEST_IN_FLIGHT_MESSAGE 单一来源）
    expect(result.current.error).toBe(REQUEST_IN_FLIGHT_MESSAGE);
  });

  it("handleSubmit sets error and calls onError when stream errors", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
        callbacks.onError(new Error("API failure"));
        return Promise.resolve();
      },
    );

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

    // 错误经真实通道 setError 上屏，并回调页面的 onError
    expect(result.current.error).toBe("API failure");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "API failure" }));
  });

  it("abort discards buffered tokens and aborts the channel request", async () => {
    // abortStream 的职责：中止请求时同时丢弃缓冲，避免 reset 后残留 token
    // 被 flush 出来。中止本身经真实通道生效（abort 事件复位 loading）。
    const stream = streamHangs();

    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
      }),
    );

    act(() => {
      void result.current.handleSubmit("input");
    });
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);

    // token 尚在缓冲中（50ms flush 定时器未到）即中止
    await act(async () => {
      stream.callbacks.onToken("partial");
    });
    act(() => {
      result.current.abort();
    });

    // 冲刷 flush 定时器窗口：被丢弃的 token 不得再出现
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(result.current.result).toBe("");
    // 中止经通道生效：loading 归位
    await waitFor(() => expect(result.current.loading).toBe(false));
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
    streamCompletesWith("manual result");

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
    streamCompletesWith("persisted text");

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
      difficulty_level: null,
    });
    expect(mockRecordLearningActivitySafe).toHaveBeenCalledWith("exercise");
  });

  it("persistResult retries the write after a failure and records activity exactly once", async () => {
    // 修复 1 回归：写库失败后占位必须释放——否则后续 persistResult()
    // 幂等返回缓存的 null，该次流式结果永久丢失且无法重试
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAddHistory.mockRejectedValueOnce(new Error("disk full"));
    streamCompletesWith("persisted text");

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
    streamCompletesWith("persisted text");

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
    streamCompletesWith("auto persisted");

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
    streamCompletesWith("first");

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

    // 新一次流式开始后，旧记录已清空：persistResult 不再返回旧 ID。
    // 第二次流式只吐 token 且挂起，模拟流式进行中（不触发 onDone）
    mockStreamChat.mockImplementationOnce(
      (_messages: unknown, _model: unknown, callbacks: DrivenCallbacks) => {
        callbacks.onToken("second");
        return new Promise<void>(() => {});
      },
    );
    await act(async () => {
      void result.current.handleSubmit("input two");
    });

    let historyId: number | null = 123;
    await act(async () => {
      historyId = await result.current.persistResult();
    });
    expect(historyId).toBeNull();
    expect(mockAddHistory).toHaveBeenCalledTimes(1); // 仍是第一次的那条
  });

  it("swallows errors thrown from onDone without producing unhandled rejection", async () => {
    // onDone 抛错由通道（use-stream-chat 的 awaited 契约）就地消化：
    // 记日志、execute 正常 resolve、不触发 onError 二次回调
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    streamCompletesWith("result");

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
    // 错误被通道就地捕获并记录，而不是浮动 unhandled rejection
    expect(consoleError).toHaveBeenCalledWith(
      "useStreamChat: onDone 回调执行失败:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("handleSubmit sets error and calls onError when buildMessages throws", async () => {
    const buildError = new Error("Failed to build messages");
    const buildMessages = vi.fn(() => {
      throw buildError;
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

    expect(result.current.error).toBe("构建提示消息失败: Failed to build messages");
    expect(onError).toHaveBeenCalledWith(buildError);
    // 构建失败在进通道之前拦截：streamChat 不被调用
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it("surfaces unexpected streamChat rejections via error state and onError (no unhandled rejection)", async () => {
    // B4 兜底（迁移至通道边界）：旧版由页面包住 execute 的 try/catch 兜底；
    // awaited 契约后 execute 承诺永不 reject——streamChat 的未预期 rejection
    // 由通道转为错误上屏 + onError 回调。页面经 usePracticeSession 调用
    // handleSubmit 时没有自己的 catch，逃逸后既无错误上屏也无加载态
    mockStreamChat.mockRejectedValueOnce(new Error("加载模型配置失败"));

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        onError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("hello");
    });

    expect(result.current.error).toBe("加载模型配置失败");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("normalizes non-Error streamChat rejections before reporting them", async () => {
    mockStreamChat.mockRejectedValueOnce("plain failure");

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        onError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("hello");
    });

    expect(result.current.error).toBe("plain failure");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
