import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAddToVocabulary } from "./use-add-to-vocabulary";

// ─── Module mocks ─────────────────────────────────────────────────

const mockAddWord = vi.fn();
const mockEnrichWord = vi.fn();

vi.mock("@/lib/db", () => ({
  addWord: (...args: unknown[]) => mockAddWord(...args),
}));

vi.mock("@/services/llm", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("useAddToVocabulary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddWord.mockResolvedValue(undefined);
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
    let addPromise: Promise<boolean>;
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
      await addPromise!;
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

    let addPromise: Promise<boolean>;
    act(() => {
      addPromise = result.current.addToVocabulary("word");
    });

    // Unmount triggers abort
    unmount();

    const success = await addPromise!;
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

  // ── 6. Prevents duplicate additions ─────────────────────────────

  it("returns false for duplicate additions of the same word", async () => {
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
    expect(second).toBe(false);
    expect(mockEnrichWord).toHaveBeenCalledOnce();
    expect(mockAddWord).toHaveBeenCalledOnce();
  });

  it("does not call enrichWord or addWord for duplicate words", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = renderHook(() => useAddToVocabulary());

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });

    // Clear mocks to verify second call doesn't invoke them
    vi.clearAllMocks();

    await act(async () => {
      await result.current.addToVocabulary("hello");
    });

    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(mockAddWord).not.toHaveBeenCalled();
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

    let addPromise: Promise<boolean>;
    act(() => {
      addPromise = result.current.addToVocabulary("hello");
    });

    await waitFor(() => {
      expect(result.current.addingWord).toBe("hello");
    });

    await act(async () => {
      resolveEnrich?.(null);
      await addPromise!;
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

    let firstPromise: Promise<boolean>;
    let secondPromise: Promise<boolean>;

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
      await Promise.all([firstPromise!, secondPromise!]);
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
