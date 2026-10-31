/**
 * useLanguageDetection hook tests.
 *
 * mock @/services/llm（buildPrompt/streamChatAsync）与 @/lib/db
 * （getDefaultModelCached——模型解析已收编进 useLlmTask 原语），覆盖
 * 成功/失败/取消基本路径，以及并发场景下的 stale-response 守卫：被取代的
 * 旧调用（superseded outcome）不得清零新调用的 detecting。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultModelCached } from "@/lib/db";
import type { LanguageDetection, ModelConfig } from "@/types";
import { isObviouslyEnglish, useLanguageDetection } from "./use-language-detection";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn(),
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
    // 原语的模型解析依赖：默认返回带 Key 的模型
    vi.mocked(getDefaultModelCached).mockResolvedValue(MODEL);
  });

  // ── 基本路径 ──────────────────────────────────────────────────────

  it("returns the parsed detection and clears detecting on success", async () => {
    mockStreamChatAsync.mockResolvedValue('{"isEnglish": true, "reason": "English text"}');

    const { result } = renderHook(() => useLanguageDetection());

    let detected: LanguageDetection | null = null;
    await act(async () => {
      detected = await result.current.detectLanguage("hello world");
    });

    expect(detected).toEqual({ isEnglish: true, reason: "English text" });
    expect(result.current.detecting).toBe(false);
  });

  it("fails closed with a retry hint when the detection request errors", async () => {
    mockStreamChatAsync.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useLanguageDetection());

    let detected: LanguageDetection | null = null;
    await act(async () => {
      detected = await result.current.detectLanguage("hello");
    });

    // M2: 失败 fail closed，阻止非英文文本进入分析
    expect(detected).toEqual({
      isEnglish: false,
      reason: "语言检测服务暂时不可用，请检查网络后重试",
    });
    expect(result.current.detecting).toBe(false);
  });

  it("fails closed when no model is configured inside the detection", async () => {
    // 模型解析收编进原语：未配置模型在检测内部报 not-configured，
    // 映射为通道规范文案（与改造前 ReadingPage 前置 resolveModel 的横幅逐字一致）
    vi.mocked(getDefaultModelCached).mockResolvedValue(null);

    const { result } = renderHook(() => useLanguageDetection());

    let detected: LanguageDetection | null = null;
    await act(async () => {
      detected = await result.current.detectLanguage("hello");
    });

    expect(detected).toEqual({
      isEnglish: false,
      reason: "请先在设置页面配置 LLM 模型。",
    });
    expect(result.current.detecting).toBe(false);
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  it("cancelDetection resets the detecting flag", async () => {
    const pending = deferred<string>();
    mockStreamChatAsync.mockImplementationOnce(() => pending.promise);

    const { result } = renderHook(() => useLanguageDetection());

    act(() => {
      void result.current.detectLanguage("hello");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.detecting).toBe(true);

    act(() => {
      result.current.cancelDetection();
    });
    expect(result.current.detecting).toBe(false);
  });

  // ── S-11: 明显英文的本地快速判定 ──────────────────────────────────

  describe("local fast path for obviously English text (S-11)", () => {
    /** 一段足够长的纯英文（字母数远超本地判定下限） */
    const LONG_ENGLISH =
      "The beauty of cherry blossoms is ephemeral, and that is precisely why people travel across the world to see them bloom.";

    it("isObviouslyEnglish accepts long ASCII English prose", () => {
      expect(isObviouslyEnglish(LONG_ENGLISH)).toBe(true);
      // 数字/标点不参与分母：代码风格文本（含英文功能词）仍可判定
      expect(
        isObviouslyEnglish(
          "The function add(a, b) returns a number, and it is used by the caller.",
        ),
      ).toBe(true);
    });

    it("isObviouslyEnglish rejects short, mixed and non-English text", () => {
      // 字母数不足：边界情况交给 LLM
      expect(isObviouslyEnglish("hello")).toBe(false);
      // 纯中文：ASCII 字母占比为 0
      expect(isObviouslyEnglish("这是英文吗？我需要一段足够长的中文文本来测试占比是否够低。")).toBe(
        false,
      );
      // 中英混合：ASCII 字母占比不足
      expect(
        isObviouslyEnglish(
          "这是一个混合了中文的段落，English words appear here but the majority of letters are Chinese characters entirely.",
        ),
      ).toBe(false);
      // 带音标拉丁文本：非 ASCII 字母占比不足
      expect(
        isObviouslyEnglish(
          "À côté d'un être très âgé, l'élève écoute la leçon élémentaire où chaque élève répète l'éphémère.",
        ),
      ).toBe(false);
      // 无音标罗曼语：字母构成几乎全 ASCII，但缺少英文功能词 —— 第二层证据兜底
      expect(
        isObviouslyEnglish(
          "Ceci est une phrase en francais sans accents, assez longue pour depasser le seuil exige par le detecteur.",
        ),
      ).toBe(false);
      // 纯数字/标点没有字母
      expect(isObviouslyEnglish("12345 !!! --- ...")).toBe(false);
    });

    it("returns English without calling the LLM for obviously English text", async () => {
      const { result } = renderHook(() => useLanguageDetection());

      let detected: LanguageDetection | null = null;
      await act(async () => {
        detected = await result.current.detectLanguage(LONG_ENGLISH);
      });

      expect(detected).toEqual({ isEnglish: true, reason: "明显英文文本（本地快速判定）" });
      expect(result.current.detecting).toBe(false);
      // 核心收益：省掉一次 LLM 往返
      expect(mockStreamChatAsync).not.toHaveBeenCalled();
      expect(getDefaultModelCached).not.toHaveBeenCalled();
    });

    it("falls back to the LLM for short English text", async () => {
      mockStreamChatAsync.mockResolvedValue('{"isEnglish": true, "reason": "English"}');

      const { result } = renderHook(() => useLanguageDetection());

      let detected: LanguageDetection | null = null;
      await act(async () => {
        detected = await result.current.detectLanguage("hello world");
      });

      expect(detected).toEqual({ isEnglish: true, reason: "English" });
      expect(mockStreamChatAsync).toHaveBeenCalledTimes(1);
    });

    it("falls back to the LLM for mixed-language text (no local rejection)", async () => {
      mockStreamChatAsync.mockResolvedValue('{"isEnglish": false, "reason": "包含中文"}');

      const { result } = renderHook(() => useLanguageDetection());

      let detected: LanguageDetection | null = null;
      await act(async () => {
        detected = await result.current.detectLanguage(
          "这是一段中文文本，mixed with some English words 但主体是中文，因此需要 LLM 判定。",
        );
      });

      expect(detected).toEqual({ isEnglish: false, reason: "包含中文" });
      expect(mockStreamChatAsync).toHaveBeenCalledTimes(1);
    });

    it("local verdict supersedes an in-flight LLM detection", async () => {
      // 上一次 LLM 检测仍在途时，本地快速判定接管：旧调用放弃（null），
      // detecting 归零，不会被旧调用的迟到收尾改回 true
      const pending = deferred<string>();
      mockStreamChatAsync.mockImplementationOnce(() => pending.promise);

      const { result } = renderHook(() => useLanguageDetection());

      let first!: Promise<LanguageDetection | null>;
      act(() => {
        first = result.current.detectLanguage("text-1");
      });
      await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
      expect(result.current.detecting).toBe(true);

      let fastResult: LanguageDetection | null = null;
      await act(async () => {
        fastResult = await result.current.detectLanguage(LONG_ENGLISH);
      });

      expect(fastResult).toEqual({ isEnglish: true, reason: "明显英文文本（本地快速判定）" });
      expect(result.current.detecting).toBe(false);

      // 在途请求被 abort：真实 streamChatAsync 以 AbortError 拒绝 → outcome=aborted → null
      let firstResult: LanguageDetection | null = null;
      await act(async () => {
        pending.reject(abortError());
        firstResult = await first;
      });

      expect(firstResult).toBeNull();
      expect(result.current.detecting).toBe(false);
      // 本地判定不发起第二次 LLM 请求
      expect(mockStreamChatAsync).toHaveBeenCalledTimes(1);
    });
  });

  // ── stale-response 守卫 ───────────────────────────────────────────

  it("keeps the new detection's detecting flag when the old call fails late", async () => {
    // 并发场景：第二次 detectLanguage 取代第一次（abort + begin）后，第一次
    // 的失败迟到返回——不得清零第二次的 detecting
    const firstDetect = deferred<string>();
    const secondDetect = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstDetect.promise)
      .mockImplementationOnce(() => secondDetect.promise);

    const { result } = renderHook(() => useLanguageDetection());

    // 第一次检测在途
    let first!: Promise<LanguageDetection | null>;
    act(() => {
      first = result.current.detectLanguage("text-1");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.detecting).toBe(true);

    // 第二次检测取代第一次
    let second!: Promise<LanguageDetection | null>;
    act(() => {
      second = result.current.detectLanguage("text-2");
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
      void result.current.detectLanguage("text-1");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.detectLanguage("text-2");
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
