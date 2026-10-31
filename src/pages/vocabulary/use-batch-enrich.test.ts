/**
 * use-batch-enrich hook 行为测试。
 *
 * 覆盖空字段补全失败（E5：空 phonetic / 空 definition 均不写库、计失败、
 * 汇总消息降级为 info）与成功路径、无需补全时的空转。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "@/types";
import { useBatchEnrich } from "./use-batch-enrich";

const mockUpdateWordEnrichment = vi.fn();
const mockEnrichWord = vi.fn();

vi.mock("@/lib/db", () => ({
  updateWordEnrichment: (...args: unknown[]) => mockUpdateWordEnrichment(...args),
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Fixtures ──────────────────────────────────────────────────────

function makeWord(id: number, word: string, overrides: Partial<Word> = {}): Word {
  return {
    id,
    word,
    phonetic: null,
    definition: "待补充",
    level: null,
    source_type: "manual",
    source_text: null,
    notes: null,
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-01-01T00:00:00",
    ...overrides,
  };
}

const enriched = {
  phonetic: "/ˈæpl/",
  definition: "苹果",
  collocations: "apple pie",
  example: "I ate an apple.",
  level: "CET-4",
};

// ─── Helpers ───────────────────────────────────────────────────────

const showMessage = vi.fn();
const refresh = vi.fn();

function setup(words: Word[]) {
  return renderHook(() =>
    useBatchEnrich({
      words,
      cancelledRef: { current: false },
      refresh,
      showMessage,
    }),
  );
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("useBatchEnrich", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWordEnrichment.mockResolvedValue(undefined);
    mockEnrichWord.mockResolvedValue(enriched);
  });

  it("writes enrichment and reports success when both core fields are present", async () => {
    const { result } = setup([makeWord(1, "apple")]);

    await act(async () => {
      await result.current.handleBatchEnrich();
    });

    expect(mockUpdateWordEnrichment).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ phonetic: "/ˈæpl/", definition: "苹果" }),
    );
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个成功"));
    expect(refresh).toHaveBeenCalled();
  });

  it("counts a whitespace-only phonetic as a failure without writing to the db", async () => {
    // 空 phonetic 会写成空串、覆盖词库原有音标；必须整条视为失败
    mockEnrichWord.mockResolvedValue({ ...enriched, phonetic: "  " });

    const { result } = setup([makeWord(1, "apple")]);
    await act(async () => {
      await result.current.handleBatchEnrich();
    });

    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("info", expect.stringContaining("1 个失败（可重试）"));
    expect(showMessage).toHaveBeenCalledWith("info", expect.stringContaining("0 个成功"));
    expect(refresh).toHaveBeenCalled();
  });

  it("counts an empty definition as a failure without writing to the db", async () => {
    mockEnrichWord.mockResolvedValue({ ...enriched, definition: "" });

    const { result } = setup([makeWord(1, "apple")]);
    await act(async () => {
      await result.current.handleBatchEnrich();
    });

    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("info", expect.stringContaining("1 个失败（可重试）"));
  });

  it("reports mixed outcomes when one row is usable and one is empty", async () => {
    mockEnrichWord
      .mockResolvedValueOnce(enriched)
      .mockResolvedValueOnce({ ...enriched, definition: "   " });

    const { result } = setup([makeWord(1, "apple"), makeWord(2, "banana")]);
    await act(async () => {
      await result.current.handleBatchEnrich();
    });

    expect(mockUpdateWordEnrichment).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).toHaveBeenCalledWith(1, expect.any(Object));
    expect(showMessage).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("1 个成功，1 个失败（可重试）"),
    );
  });

  it("does nothing when no word needs enrichment", async () => {
    const done = makeWord(2, "done", { phonetic: "/dʌn/", definition: "完成的" });

    const { result } = setup([done]);
    await act(async () => {
      await result.current.handleBatchEnrich();
    });

    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("starts up to 3 enrichment requests concurrently (S-17)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    mockEnrichWord.mockImplementation(async (word: string) => {
      started.push(word);
      await gate;
      return enriched;
    });

    const { result } = setup([
      makeWord(1, "apple"),
      makeWord(2, "banana"),
      makeWord(3, "cherry"),
      makeWord(4, "date"),
    ]);
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.handleBatchEnrich();
      await Promise.resolve();
    });

    // worker pool 并发度 3：第 4 个词要等前 3 个之一完成后再开始
    expect(started).toEqual(["apple", "banana", "cherry"]);

    await act(async () => {
      release();
      await pending;
    });
    expect(started).toEqual(["apple", "banana", "cherry", "date"]);
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("4 个成功"));
  });

  it("aborts in-flight enrichment on unmount (S-17)", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockEnrichWord.mockImplementation((_word: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    const { result, unmount } = setup([makeWord(1, "apple")]);
    act(() => {
      void result.current.handleBatchEnrich();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
