import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAddToVocabulary } from "./use-add-to-vocabulary";

/** 断言捕获的 Promise 存在后返回(替代非空断言,失败时报可读错误) */
function requiredPromise<T>(p: Promise<T> | null | undefined, name: string): Promise<T> {
  if (!p) throw new Error(`${name} was not captured`);
  return p;
}

// ─── Module mocks ─────────────────────────────────────────────────

const mockAddWord = vi.fn();
const mockEnrichWord = vi.fn();
const mockGetWords = vi.fn();

vi.mock("@/lib/db", () => ({
  addWord: (...args: unknown[]) => mockAddWord(...args),
  getWords: (...args: unknown[]) => mockGetWords(...args),
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("useAddToVocabulary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddWord.mockResolvedValue(undefined);
    // 默认词库无此词（存在性预检不命中），走完整 enrich+add 流程
    mockGetWords.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Initial state ────────────────────────────────────────────

  it("returns initial state with empty addedWords, null addingWord, and false enriching", () => {
    const { result } = renderHook(() => useAddToVocabulary());

    expect(result.current.addedWords).toBeInstanceOf(Set);
    expect(result.current.addedWords.size).toBe(0);
    expect(result.current.addingWord).toBeNull();
    expect(result.current.addingWords).toBeInstanceOf(Set);
    expect(result.current.addingWords.size).toBe(0);
    expect(result.current.enriching).toBe(false);
    expect(typeof result.current.addToVocabulary).toBe("function");
  });

  // ── 2. addToVocabulary calls addWord with correct parameters ────

  it("calls addWord with correct parameters after enrichment", async () => {
    mockEnrichWord.mockResolvedValue({
      phonetic: "/həˈloʊ/",
      definition: "你好",
      collocations: "say hello",
      example: "She said hello to everyone.",
    });

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("hello", "context text", "reading");
    });

    expect(success).toBe(true);
    expect(mockEnrichWord).toHaveBeenCalledOnce();
    expect(mockEnrichWord).toHaveBeenCalledWith("hello", expect.any(AbortSignal));

    expect(mockAddWord).toHaveBeenCalledOnce();
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        word: "hello",
        phonetic: "/həˈloʊ/",
        definition: "你好",
        level: null,
        source_type: "reading",
        source_text: "context text",
        review_status: "new",
      }),
    );
  });

  it("uses default sourceType 'manual' when not specified", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("test");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "manual",
      }),
    );
  });

  it("truncates sourceText to 200 characters", async () => {
    mockEnrichWord.mockResolvedValue(null);
    const longText = "a".repeat(300);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("word", longText, "reading");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        source_text: "a".repeat(200),
      }),
    );
  });

  it("passes null sourceText when not provided", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("word");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        source_text: null,
      }),
    );
  });

  // ── 3. addToVocabulary enriches the word via LLM ───────────────

  it("uses enriched data from LLM when enrichment succeeds", async () => {
    mockEnrichWord.mockResolvedValue({
      phonetic: "/wɜːrd/",
      definition: "词；单词",
      collocations: "break the ice",
      example: "He broke the ice.",
    });

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("word");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        phonetic: "/wɜːrd/",
        definition: "词；单词",
      }),
    );
    // notes should be built from enriched data (non-null)
    const callArgs = mockAddWord.mock.calls[0][0];
    expect(callArgs.notes).toContain("音标");
    expect(callArgs.notes).toContain("搭配");
    expect(callArgs.notes).toContain("例句");
  });

  it("falls back to default definition when enrichment returns null", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("rareword");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        phonetic: null,
        definition: "待补充",
      }),
    );
  });

  it("uses fallbackDefinition when provided and enrichment returns null", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("word", undefined, "manual", "custom definition");
    });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: "custom definition",
      }),
    );
  });

  it("sets enriching to true during enrichment and false after completion", async () => {
    let resolveEnrich: (value: unknown) => void;
    mockEnrichWord.mockReturnValue(
      new Promise((resolve) => {
        resolveEnrich = resolve;
      }),
    );

    const { result } = renderHook(() => useAddToVocabulary());

    expect(result.current.enriching).toBe(false);

    // Start the add operation without awaiting
    let addPromise: Promise<boolean> | undefined;
    act(() => {
      addPromise = result.current.addToVocabulary("word");
    });

    // Wait for enriching to become true
    await waitFor(() => {
      expect(result.current.enriching).toBe(true);
    });

    // Resolve enrichment
    await act(async () => {
      resolveEnrich?.(null);
      await requiredPromise(addPromise, "addPromise");
    });

    expect(result.current.enriching).toBe(false);
  });

  // ── 4. addToVocabulary handles errors gracefully ────────────────

  it("proceeds with fallback data when enrichment throws an error", async () => {
    mockEnrichWord.mockRejectedValue(new Error("LLM API error"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("word", undefined, "reading", "fallback def");
    });

    // Should still succeed because addWord works
    expect(success).toBe(true);
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        word: "word",
        phonetic: null,
        definition: "fallback def",
        source_type: "reading",
      }),
    );

    consoleSpy.mockRestore();
  });

  it("returns false and logs warning when addWord throws", async () => {
    mockEnrichWord.mockResolvedValue(null);
    mockAddWord.mockRejectedValue(new Error("DB error"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("word");
    });

    expect(success).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith("Failed to add word:", expect.any(Error));

    consoleSpy.mockRestore();
  });

  it("returns false when signal is aborted during enrichment", async () => {
    // Create a scenario where enrichment resolves but signal is already aborted
    mockEnrichWord.mockImplementation((_word: string, signal: AbortSignal) => {
      return new Promise((resolve) => {
        // Simulate abort happening during enrichment
        signal.addEventListener("abort", () => resolve(null), { once: true });
      });
    });

    const { result, unmount } = renderHook(() => useAddToVocabulary());

    let addPromise: Promise<boolean> | undefined;
    act(() => {
      addPromise = result.current.addToVocabulary("word");
    });

    // Unmount triggers abort
    unmount();

    const success = await requiredPromise(addPromise, "addPromise");
    expect(success).toBe(false);
  });

  it("resets enriching to false even when an error occurs", async () => {
    mockEnrichWord.mockRejectedValue(new Error("fail"));
    mockAddWord.mockRejectedValue(new Error("fail"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("word");
    });

    expect(result.current.enriching).toBe(false);
    expect(result.current.addingWord).toBeNull();

    consoleSpy.mockRestore();
  });

  // ── 5. addedWords tracks which words have been added ────────────

  it("adds successfully added words to addedWords set", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });

    expect(result.current.addedWords.has("hello")).toBe(true);
    expect(result.current.addedWords.size).toBe(1);
  });

  it("tracks multiple added words", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });
    await act(async () => {
      await result.current.addToVocabulary("world");
    });

    expect(result.current.addedWords.has("hello")).toBe(true);
    expect(result.current.addedWords.has("world")).toBe(true);
    expect(result.current.addedWords.size).toBe(2);
  });

  it("does not add word to addedWords when addWord fails", async () => {
    mockEnrichWord.mockResolvedValue(null);
    mockAddWord.mockRejectedValue(new Error("DB error"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });

    expect(result.current.addedWords.has("hello")).toBe(false);
    expect(result.current.addedWords.size).toBe(0);

    consoleSpy.mockRestore();
  });

  // ── 6. Duplicate handling: 幂等下沉到数据层，UI 防重仅保留 in-flight 窗口 ──

  it("proceeds to db_add_word for a word added earlier in the session", async () => {
    // 同一单词已成功添加过（addedWords 残留）后再次添加：不再被内存态拦截，
    // 应照常调用 enrichWord + addWord（由后端幂等保证不插入重复行）
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    let first: boolean | undefined;
    let second: boolean | undefined;

    await act(async () => {
      first = await result.current.addToVocabulary("hello");
    });
    await act(async () => {
      second = await result.current.addToVocabulary("hello");
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockEnrichWord).toHaveBeenCalledTimes(2);
    expect(mockAddWord).toHaveBeenCalledTimes(2);
  });

  it("re-adds a word previously added in the session (not blocked by addedWords)", async () => {
    // 模拟"添加 → 删除 → 再添加"：addedWords 只是 UI 乐观标记，
    // 第二次添加仍会调用 db_add_word（后端幂等：已存在则返回已有 id / 删除后重插）
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });
    expect(result.current.addedWords.has("hello")).toBe(true);

    vi.clearAllMocks();

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });

    expect(mockEnrichWord).toHaveBeenCalledOnce();
    expect(mockAddWord).toHaveBeenCalledOnce();
  });

  it("returns false for a concurrent in-flight duplicate submission", async () => {
    // in-flight 窗口内同一单词的并发提交仍被拒绝（防按钮抖动/重复请求）
    let resolveEnrich: (value: unknown) => void;
    mockEnrichWord.mockReturnValue(
      new Promise((resolve) => {
        resolveEnrich = resolve;
      }),
    );

    const { result } = renderHook(() => useAddToVocabulary());

    let first: Promise<boolean> | undefined;
    act(() => {
      first = result.current.addToVocabulary("hello");
    });

    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.addToVocabulary("hello");
    });
    expect(second).toBe(false);
    expect(mockEnrichWord).toHaveBeenCalledOnce();

    await act(async () => {
      resolveEnrich?.(null);
      await requiredPromise(first, "first");
    });
  });

  // ── 7. 词库存在性预检：已有词不再白耗 LLM 富化 ─────────────────

  it("skips enrichWord and addWord when the word already exists in the vocabulary", async () => {
    // 词库已有该词：预检命中 → 跳过 enrichWord/addWord（后端 add_word 幂等命中
    // 会丢弃新数据，提前拦截避免白耗一次 LLM 调用），返回 false 并把词补进
    // addedWords 使 UI 呈现"已添加"（与原会话级防重命中的对外语义一致）
    mockGetWords.mockResolvedValue([{ word: "hello" }]);

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("hello");
    });

    expect(success).toBe(false);
    expect(mockGetWords).toHaveBeenCalledWith(undefined, undefined, "hello");
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(mockAddWord).not.toHaveBeenCalled();
    expect(result.current.addedWords.has("hello")).toBe(true);
    expect(result.current.enriching).toBe(false);
  });

  it("treats a word differing only in case as already existing", async () => {
    // 精确比对大小写不敏感：对齐后端 lower(word) = lower(?) 的 ASCII 语义
    mockGetWords.mockResolvedValue([{ word: "Hello" }]);

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("hello");
    });

    expect(success).toBe(false);
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(mockAddWord).not.toHaveBeenCalled();
  });

  it("proceeds with the full flow when search only fuzzily matches similar words", async () => {
    // search 是模糊 LIKE：搜索有相近结果不代表词条已存在，
    // 必须对 term 精确比对——这里候选均与 "hello" 不完全一致，应照常 enrich+add
    mockGetWords.mockResolvedValue([{ word: "helloes" }, { word: "helloworld" }]);
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("hello");
    });

    expect(success).toBe(true);
    expect(mockEnrichWord).toHaveBeenCalledOnce();
    expect(mockAddWord).toHaveBeenCalledOnce();
  });

  it("falls back to enrich+add when the existence precheck fails", async () => {
    // 预查词库异常时按未命中处理，退回完整流程，由后端 add_word 幂等兜底
    mockGetWords.mockRejectedValue(new Error("DB error"));
    mockEnrichWord.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useAddToVocabulary());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.addToVocabulary("hello");
    });

    expect(success).toBe(true);
    expect(mockEnrichWord).toHaveBeenCalledOnce();
    expect(mockAddWord).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Vocabulary existence precheck failed:",
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  // ── addingWord / addingWords state ──────────────────────────────

  it("sets addingWord while enrichment is in progress", async () => {
    let resolveEnrich: (value: unknown) => void;
    mockEnrichWord.mockReturnValue(
      new Promise((resolve) => {
        resolveEnrich = resolve;
      }),
    );

    const { result } = renderHook(() => useAddToVocabulary());

    expect(result.current.addingWord).toBeNull();

    let addPromise: Promise<boolean> | undefined;
    act(() => {
      addPromise = result.current.addToVocabulary("hello");
    });

    await waitFor(() => {
      expect(result.current.addingWord).toBe("hello");
    });

    await act(async () => {
      resolveEnrich?.(null);
      await requiredPromise(addPromise, "addPromise");
    });

    expect(result.current.addingWord).toBeNull();
  });

  it("tracks concurrent additions in addingWords", async () => {
    let resolveFirst: (value: unknown) => void;
    let resolveSecond: (value: unknown) => void;

    mockEnrichWord
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { result } = renderHook(() => useAddToVocabulary());

    let firstPromise: Promise<boolean> | undefined;
    let secondPromise: Promise<boolean> | undefined;

    act(() => {
      firstPromise = result.current.addToVocabulary("hello");
      secondPromise = result.current.addToVocabulary("world");
    });

    await waitFor(() => {
      expect(result.current.addingWords.size).toBe(2);
      expect(result.current.addingWords.has("hello")).toBe(true);
      expect(result.current.addingWords.has("world")).toBe(true);
    });

    await act(async () => {
      resolveFirst?.(null);
      resolveSecond?.(null);
      await Promise.all([
        requiredPromise(firstPromise, "firstPromise"),
        requiredPromise(secondPromise, "secondPromise"),
      ]);
    });

    expect(result.current.addingWords.size).toBe(0);
    expect(result.current.enriching).toBe(false);
  });

  // ── Unmount aborts active controllers ───────────────────────────

  it("aborts active controllers on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockEnrichWord.mockImplementation((_word: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves
    });

    const { result, unmount } = renderHook(() => useAddToVocabulary());

    act(() => {
      result.current.addToVocabulary("hello");
    });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
