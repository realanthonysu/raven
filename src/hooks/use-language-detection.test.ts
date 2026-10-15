/**
 * useLanguageDetection hook tests.
 *
 * Mock @/services/llm（buildPrompt/streamChatAsync），覆盖成功/失败/取消
 * 基本路径，以及并发场景下的 stale-response 守卫：被取代的旧调用（catch 与
 * 成功路径）不得清零新调用的 detecting。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageDetection, ModelConfig } from "@/types";
import { useLanguageDetection } from "./use-language-detection";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

const MODEL: ModelConfig = {
  id: 1,
  name: "test-model",
  api_key: "sk-test-key",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** AbortError（与 use-abortable.test.ts 同款构造） */
function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/** 外部可控的 Promise，用于精确编排乱序返回时序 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 冲刷微任务队列，让迟到的 await  continuation 走完 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useLanguageDetection", () => {
  beforeEach(() => {
    // resetAllMocks：mockClear 不清除 mockImplementationOnce 队列，失败测试
    // 残留的一次性实现会污染后续测试（本文件重度依赖 once 时序编排）
    vi.resetAllMocks();
  });

  // ── 基本路径 ──────────────────────────────────────────────────────

  it("returns the parsed detection and clears detecting on success", async () => {
    mockStreamChatAsync.mockResolvedValue('{"isEnglish": true, "reason": "English text"}');

    const { result } = renderHook(() => useLanguageDetection());

    let detected: LanguageDetection | null = null;
    await act(async () => {
      detected = await result.current.detectLanguage("hello world", MODEL);
    });

    expect(detected).toEqual({ isEnglish: true, reason: "English text" });
    expect(result.current.detecting).toBe(false);
  });

  it("fails closed with a retry hint when the detection request errors", async () => {
    mockStreamChatAsync.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useLanguageDetection());

    let detected: LanguageDetection | null = null;
    await act(async () => {
      detected = await result.current.detectLanguage("hello", MODEL);
    });

    // M2: 失败 fail closed，阻止非英文文本进入分析
    expect(detected).toEqual({
      isEnglish: false,
      reason: "语言检测服务暂时不可用，请检查网络后重试",
    });
    expect(result.current.detecting).toBe(false);
  });

  it("cancelDetection resets the detecting flag", async () => {
    const pending = deferred<string>();
    mockStreamChatAsync.mockImplementationOnce(() => pending.promise);

    const { result } = renderHook(() => useLanguageDetection());

    act(() => {
      void result.current.detectLanguage("hello", MODEL);
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.detecting).toBe(true);

    act(() => {
      result.current.cancelDetection();
    });
    expect(result.current.detecting).toBe(false);
  });

  // ── stale-response 守卫 ───────────────────────────────────────────

  it("keeps the new detection's detecting flag when the old call fails late", async () => {
    // 并发场景：第二次 detectLanguage 取代第一次（abort + begin）后，第一次
    // 的 catch 迟到执行——不得清零第二次的 detecting
    const firstDetect = deferred<string>();
    const secondDetect = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstDetect.promise)
      .mockImplementationOnce(() => secondDetect.promise);

    const { result } = renderHook(() => useLanguageDetection());

    // 第一次检测在途
    let first!: Promise<LanguageDetection | null>;
    act(() => {
      first = result.current.detectLanguage("text-1", MODEL);
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.detecting).toBe(true);

    // 第二次检测取代第一次
    let second!: Promise<LanguageDetection | null>;
    act(() => {
      second = result.current.detectLanguage("text-2", MODEL);
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    // 第一次迟到失败（signal 已被第二次 abort）
    let firstResult: LanguageDetection | null = null;
    await act(async () => {
      firstDetect.reject(abortError());
      firstResult = await first;
    });

    // 核心断言：旧调用的 catch 没有清零新调用的 detecting
    expect(result.current.detecting).toBe(true);
    // 被接管与中止同语义：调用方放弃本次流程
    expect(firstResult).toBeNull();

    // 第二次成功收尾，detecting 归位
    let secondResult: LanguageDetection | null = null;
    await act(async () => {
      secondDetect.resolve('{"isEnglish": true}');
      secondResult = await second;
    });

    expect(secondResult).toEqual({ isEnglish: true });
    expect(result.current.detecting).toBe(false);
  });

  it("keeps the new detection's detecting flag when the old call succeeds late", async () => {
    // 乱序成功路径同病：旧调用成功返回时的 setDetecting(false) 同样不得
    // 清零新调用的 detecting
    const firstDetect = deferred<string>();
    const secondDetect = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstDetect.promise)
      .mockImplementationOnce(() => secondDetect.promise);

    const { result } = renderHook(() => useLanguageDetection());

    act(() => {
      void result.current.detectLanguage("text-1", MODEL);
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.detectLanguage("text-2", MODEL);
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    // 第一次迟到成功（乱序）
    await act(async () => {
      firstDetect.resolve('{"isEnglish": true}');
      await flushMicrotasks();
    });

    // 核心断言：旧调用的成功路径没有清零新调用的 detecting
    expect(result.current.detecting).toBe(true);

    // 第二次成功收尾
    await act(async () => {
      secondDetect.resolve('{"isEnglish": true}');
      await flushMicrotasks();
    });

    expect(result.current.detecting).toBe(false);
  });
});
