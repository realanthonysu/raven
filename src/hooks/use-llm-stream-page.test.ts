import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLLMStreamPage } from "./use-llm-stream-page";

// ─── Module mocks ─────────────────────────────────────────────────

const mockExecute = vi.fn();
const mockAbort = vi.fn();

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: vi.fn(() => ({
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: mockExecute,
    abort: mockAbort,
  })),
}));

const mockAddHistorySafe = vi.fn().mockResolvedValue(42);
const mockRecordLearningActivity = vi.fn().mockResolvedValue(undefined);
const mockRecordLearningActivitySafe = vi.fn();

vi.mock("@/lib/db", () => ({
  addHistorySafe: (...args: unknown[]) => mockAddHistorySafe(...args),
  recordLearningActivity: (...args: unknown[]) => mockRecordLearningActivity(...args),
  recordLearningActivitySafe: (...args: unknown[]) => mockRecordLearningActivitySafe(...args),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("useLLMStreamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("handleSubmit persists history via addHistorySafe with default record", async () => {
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

    expect(mockAddHistorySafe).toHaveBeenCalledWith(
      {
        type: "writing",
        input_text: "my essay",
        result: "correction result",
      },
      undefined,
    );
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
    expect(mockAddHistorySafe).toHaveBeenCalledWith(
      {
        type: "exercise",
        input_text: "category: grammar",
        result: expect.any(String),
      },
      undefined,
    );
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

  it("handleSubmit passes onHistoryError to addHistorySafe", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("result");
      },
    );

    const onHistoryError = vi.fn();
    const { result } = renderHook(() =>
      useLLMStreamPage({
        activityType: "writing",
        buildMessages: (input) => ["sys", input],
        onHistoryError,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit("text");
    });

    expect(mockAddHistorySafe).toHaveBeenCalledWith(
      {
        type: "writing",
        input_text: "text",
        result: "result",
      },
      onHistoryError,
    );
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

    expect(mockAddHistorySafe).not.toHaveBeenCalled();
  });

  it("handleSubmit records learning activity for all activity types", async () => {
    mockExecute.mockImplementation(
      async (_sys: string, _usr: string, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("ok");
      },
    );

    for (const activityType of ["writing", "reading", "exercise", "listening"] as const) {
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
    mockAddHistorySafe.mockResolvedValue(99);
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
});
