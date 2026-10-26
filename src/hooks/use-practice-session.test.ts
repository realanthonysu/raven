/**
 * usePracticeSession hook tests.
 *
 * mock 策略：在 @/hooks/use-llm-stream-page 的 interface 上 mock（参考现有
 * 页面测试的 hook mock 方式）——捕获 useLLMStreamPage 收到的 options，用例
 * 通过驱动 handleSubmit / persistResult 的 mock 来模拟通道完成/失败/写库
 * 结果，断言落在本 module 的编排语义上：解析分发、错误文案注入、
 * isGenerating 生命周期、持久化记录的形状。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { UseLLMStreamPageOptions } from "./use-llm-stream-page";
import type { PracticeSessionConfig } from "./use-practice-session";
import { usePracticeSession } from "./use-practice-session";

// ─── Module mocks ─────────────────────────────────────────────────

let capturedOptions: UseLLMStreamPageOptions | null = null;
let mockHandleSubmit: ReturnType<typeof vi.fn>;
let mockPersistResult: ReturnType<typeof vi.fn>;
let mockAbort: ReturnType<typeof vi.fn>;

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    return {
      handleSubmit: mockHandleSubmit,
      abort: mockAbort,
      persistResult: mockPersistResult,
    };
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────

const TestSchema = z.object({ items: z.array(z.string()) });
type TestData = z.infer<typeof TestSchema>;

function makeConfig(
  overrides: Partial<PracticeSessionConfig<TestData>> = {},
): PracticeSessionConfig<TestData> {
  return {
    activityType: "exercise" as const,
    schema: TestSchema,
    buildMessages: () => ["sys", "user"] as [string, string],
    onParsed: vi.fn(),
    reportError: vi.fn(),
    buildInputText: () => "练习: 主题",
    onSaveError: vi.fn(),
    ...overrides,
  };
}

describe("usePracticeSession", () => {
  beforeEach(() => {
    capturedOptions = null;
    mockHandleSubmit = vi.fn().mockResolvedValue(undefined);
    mockPersistResult = vi.fn().mockResolvedValue(42);
    mockAbort = vi.fn();
  });

  it("wires activityType, autoPersist:false and passthrough options into useLLMStreamPage", () => {
    const config = makeConfig({ getDifficultyLevel: () => "B1" });

    renderHook(() => usePracticeSession<TestData>(config));

    expect(capturedOptions?.activityType).toBe("exercise");
    expect(capturedOptions?.autoPersist).toBe(false);
    expect(capturedOptions?.buildMessages).toBe(config.buildMessages);
    expect(capturedOptions?.getDifficultyLevel).toBe(config.getDifficultyLevel);
  });

  it("(a) delivers the parsed value to onParsed and cycles isGenerating true→false on success", async () => {
    const onParsed = vi.fn();
    const { result } = renderHook(() => usePracticeSession<TestData>(makeConfig({ onParsed })));
    mockHandleSubmit.mockImplementation(async () => {
      await Promise.resolve();
      capturedOptions?.onDone?.('{"items":["alpha","beta"]}', null);
    });

    let generatePromise!: Promise<void>;
    act(() => {
      generatePromise = result.current.generate();
    });
    // 发起后、handleSubmit resolve 前：生成中
    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      await generatePromise;
    });

    expect(result.current.isGenerating).toBe(false);
    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(onParsed.mock.calls[0][0]).toEqual({ items: ["alpha", "beta"] });
  });

  it("(b) reports the default message and triggers the fallback when parsing fails", async () => {
    const onParsed = vi.fn();
    const reportError = vi.fn();
    const onGenerationFailure = vi.fn();
    const { result } = renderHook(() =>
      usePracticeSession<TestData>(makeConfig({ onParsed, reportError, onGenerationFailure })),
    );
    // 流式完成但 JSON 非法：extractJsonSafe 返回 null（不抛错）
    mockHandleSubmit.mockImplementation(async () => {
      capturedOptions?.onDone?.("not valid json at all", null);
    });

    await act(async () => {
      await result.current.generate();
    });

    expect(onParsed).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("生成失败，请重试。");
    expect(onGenerationFailure).toHaveBeenCalledTimes(1);
  });

  it("(b2) uses the injected parseErrorMessage when parsing fails", async () => {
    const reportError = vi.fn();
    const { result } = renderHook(() =>
      usePracticeSession<TestData>(
        makeConfig({ reportError, parseErrorMessage: "解析练习题失败，请重试。" }),
      ),
    );
    mockHandleSubmit.mockImplementation(async () => {
      capturedOptions?.onDone?.("not valid json at all", null);
    });

    await act(async () => {
      await result.current.generate();
    });

    expect(reportError).toHaveBeenCalledWith("解析练习题失败，请重试。");
  });

  it("(c) wraps generation errors with formatGenerationError and triggers the fallback", async () => {
    const reportError = vi.fn();
    const onGenerationFailure = vi.fn();
    const { result } = renderHook(() =>
      usePracticeSession<TestData>(
        makeConfig({
          reportError,
          onGenerationFailure,
          formatGenerationError: (message) => `生成失败：${message}`,
        }),
      ),
    );
    mockHandleSubmit.mockImplementation(async () => {
      capturedOptions?.onError?.(new Error("network down"));
    });

    await act(async () => {
      await result.current.generate();
    });

    expect(reportError).toHaveBeenCalledWith("生成失败：network down");
    expect(onGenerationFailure).toHaveBeenCalledTimes(1);
  });

  it("(c2) passes generation errors through verbatim without formatGenerationError", async () => {
    const reportError = vi.fn();
    const { result } = renderHook(() => usePracticeSession<TestData>(makeConfig({ reportError })));
    mockHandleSubmit.mockImplementation(async () => {
      capturedOptions?.onError?.(new Error("服务不可用"));
    });

    await act(async () => {
      await result.current.generate();
    });

    expect(reportError).toHaveBeenCalledWith("服务不可用");
  });

  it("(d) persists the stringified result with input_text from buildInputText and returns the id", async () => {
    const onSaveError = vi.fn();
    const { result } = renderHook(() => usePracticeSession<TestData>(makeConfig({ onSaveError })));
    // 模拟真实 persistStream：写库前经 buildHistoryRecord 构建记录
    let builtRecord: Record<string, unknown> | null = null;
    mockPersistResult.mockImplementation(async () => {
      builtRecord = (capturedOptions?.buildHistoryRecord?.("", "") ?? null) as Record<
        string,
        unknown
      > | null;
      return 42;
    });

    const payload = { items: ["alpha"], score: 1 };
    let historyId: number | null = null;
    await act(async () => {
      historyId = await result.current.persistWithResult(payload);
    });

    expect(historyId).toBe(42);
    // history 记录形状：result 是 stringify 后的对象、input_text 来自 buildInputText
    expect(builtRecord).toEqual({
      type: "exercise",
      input_text: "练习: 主题",
      result: JSON.stringify(payload),
    });
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("(e) calls onSaveError with the default message and returns null when persistence fails", async () => {
    const onSaveError = vi.fn();
    const { result } = renderHook(() => usePracticeSession<TestData>(makeConfig({ onSaveError })));
    mockPersistResult.mockResolvedValue(null);

    let historyId: number | null = 0;
    await act(async () => {
      historyId = await result.current.persistWithResult({ items: [] });
    });

    expect(historyId).toBeNull();
    expect(onSaveError).toHaveBeenCalledWith("保存失败");
  });

  it("(e2) uses the injected saveErrorMessage when persistence fails", async () => {
    const onSaveError = vi.fn();
    const { result } = renderHook(() =>
      usePracticeSession<TestData>(
        makeConfig({ onSaveError, saveErrorMessage: "练习结果保存失败" }),
      ),
    );
    mockPersistResult.mockResolvedValue(null);

    await act(async () => {
      await result.current.persistWithResult({ items: [] });
    });

    expect(onSaveError).toHaveBeenCalledWith("练习结果保存失败");
  });

  it("(f) resets isGenerating in the finally block when generate rejects", async () => {
    const { result } = renderHook(() => usePracticeSession<TestData>(makeConfig()));
    mockHandleSubmit.mockRejectedValue(new Error("boom"));

    let generatePromise!: Promise<void>;
    act(() => {
      generatePromise = result.current.generate();
    });
    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      await expect(generatePromise).rejects.toThrow("boom");
    });

    expect(result.current.isGenerating).toBe(false);
  });
});
