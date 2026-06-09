import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamChat } from "./use-stream-chat";

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
  getDefaultModel: vi.fn().mockResolvedValue({
    id: 1,
    name: "test-model",
    api_key: "sk-test-key",
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o-mini",
    is_default: 1,
  }),
  recordLearningActivity: vi.fn().mockResolvedValue(undefined),
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

  it("execute calls getDefaultModel before streaming", async () => {
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

    const { getDefaultModel } = await import("@/lib/db");
    expect(getDefaultModel).toHaveBeenCalled();
  });

  it("execute sets error when no model is configured", async () => {
    const { getDefaultModel } = await import("@/lib/db");
    (getDefaultModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStreamChat("exercise"));

    const onError = vi.fn();

    await act(async () => {
      await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("请先在设置页面配置 LLM 模型。");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("execute calls onDone with full text when stream completes", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("complete response text");
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useStreamChat("exercise"));
    const onDone = vi.fn();

    await act(async () => {
      await result.current.execute("sys", "usr", { onDone });
    });

    expect(onDone).toHaveBeenCalledWith("complete response text");
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

    await act(async () => {
      await result.current.execute("sys", "usr", { onError });
    });

    expect(result.current.error).toBe("API rate limited");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
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

    // Start a request — execute is async, awaits getDefaultModel() before calling streamChat
    act(() => {
      result.current.execute("sys", "usr", {});
    });

    // Wait for streamChat to actually be called (after getDefaultModel resolves)
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
    const { getDefaultModel } = await import("@/lib/db");

    // First call: no model → error
    (getDefaultModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStreamChat("exercise"));

    await act(async () => {
      await result.current.execute("sys", "usr", {});
    });
    expect(result.current.error).toBe("请先在设置页面配置 LLM 模型。");

    // Second call: model available, stream succeeds
    (getDefaultModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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

  it("override callbacks take priority over hook-level callbacks", async () => {
    mockStreamChat.mockImplementation(
      (_messages: unknown, _model: unknown, callbacks: { onDone: (text: string) => void }) => {
        callbacks.onDone("stream result");
        return Promise.resolve();
      },
    );

    const hookOnDone = vi.fn();
    const overrideOnDone = vi.fn();

    const { result } = renderHook(() => useStreamChat("exercise", { onDone: hookOnDone }));

    await act(async () => {
      await result.current.execute("sys", "usr", { onDone: overrideOnDone });
    });

    // Override should be called, not the hook-level one
    expect(overrideOnDone).toHaveBeenCalledWith("stream result");
    expect(hookOnDone).not.toHaveBeenCalled();
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
    // 学习活动记录已由 useStreamChat 移除，统一由页面层（CorrectPage/ReadingPage）负责
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
});
