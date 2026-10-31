/**
 * use-vocabulary-import hook 行为测试。
 *
 * 覆盖 CSV 表头判定（E1：只看首个字段）、批量插入去重（E2：addWordsBatch 的
 * inserted=false 计 skipped）、失败计数汇总（E3）、空字段补全失败（E5）与
 * 分块批量调用（D-03/H-11：不再调用全量 getWords）。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useVocabularyImport } from "./use-vocabulary-import";

const mockAddWordsBatch = vi.fn();
const mockUpdateWordEnrichment = vi.fn();
const mockEnrichWord = vi.fn();
const mockGetWords = vi.fn();

vi.mock("@/lib/db", () => ({
  addWordsBatch: (...args: unknown[]) => mockAddWordsBatch(...args),
  getWords: (...args: unknown[]) => mockGetWords(...args),
  updateWordEnrichment: (...args: unknown[]) => mockUpdateWordEnrichment(...args),
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Fixtures ──────────────────────────────────────────────────────

/** 构造 file input change 事件（jsdom 的 File.text() 读取内存内容） */
function fileChangeEvent(content: string): React.ChangeEvent<HTMLInputElement> {
  const file = new File([content], "words.csv", { type: "text/csv" });
  return {
    target: { files: [file], value: "words.csv" },
  } as unknown as React.ChangeEvent<HTMLInputElement>;
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

function setup() {
  return renderHook(() =>
    useVocabularyImport({
      cancelledRef: { current: false },
      refresh,
      showMessage,
    }),
  );
}

/** 触发一次文件导入并等待其全部完成 */
async function importFile(content: string) {
  const { result } = setup();
  await act(async () => {
    await result.current.handleFileChange(fileChangeEvent(content));
  });
  return result;
}

/** 默认批量结果：每条都成功插入，id 从 1 递增 */
function allInserted(inputs: Array<{ word: string }>) {
  return inputs.map((_input, i) => ({ id: i + 1, inserted: true, error: null }));
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("useVocabularyImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddWordsBatch.mockImplementation((inputs: Array<{ word: string }>) =>
      Promise.resolve(allInserted(inputs)),
    );
    mockGetWords.mockResolvedValue([]);
    mockUpdateWordEnrichment.mockResolvedValue(undefined);
    mockEnrichWord.mockResolvedValue(enriched);
  });

  // ── E1：表头判定只看首个字段 ──

  it("imports a first data line that merely contains 'word' as a substring", async () => {
    // "sword" 含子串 "word"：整行 includes 判定会把首行数据误判为表头而整行丢弃
    await importFile(["sword,/sɔːd/,n. 剑", "shield,/ʃiːld/,n. 盾"].join("\n"));

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    const inputs = mockAddWordsBatch.mock.calls[0][0] as Array<{ word: string; phonetic: string }>;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual(expect.objectContaining({ word: "sword", phonetic: "/sɔːd/" }));
    expect(inputs[1]).toEqual(expect.objectContaining({ word: "shield" }));
    // 两行均有释义，不触发补全
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("success", "导入完成：2 个新词");
  });

  it("skips a genuine header row whose first field is exactly 'word'", async () => {
    await importFile(["word,phonetic,definition,level", "hello,/həˈloʊ/,你好,CET-4"].join("\n"));

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    const inputs = mockAddWordsBatch.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual(
      expect.objectContaining({ word: "hello", phonetic: "/həˈloʊ/", definition: "你好" }),
    );
    expect(mockEnrichWord).not.toHaveBeenCalled();
  });

  // ── E2：批量插入去重（inserted=false 计 skipped）──

  it("does not read the full word list before importing", async () => {
    await importFile("apple,你好");

    // 旧实现的 getWords() 全量去重基线已删除——去重由 addWordsBatch 的
    // inserted=false 在单事务内判定
    expect(mockGetWords).not.toHaveBeenCalled();
    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
  });

  it("skips words already in the notebook without overwriting their data", async () => {
    // 已存在行（hello）返回 inserted=false；world 正常插入
    mockAddWordsBatch.mockResolvedValueOnce([
      { id: 7, inserted: false, error: null },
      { id: 8, inserted: true, error: null },
    ]);

    await importFile(["hello", "world,,世界"].join("\n"));

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    const inputs = mockAddWordsBatch.mock.calls[0][0] as Array<{ word: string }>;
    expect(inputs.map((i) => i.word)).toEqual(["hello", "world"]);
    // 已存在行绝不触发补全写库（旧音标/笔记保留）
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个重复跳过"));
  });

  it("deduplicates repeated lines within the same file (backend inserted=false)", async () => {
    mockAddWordsBatch.mockResolvedValueOnce([
      { id: 1, inserted: true, error: null },
      { id: 1, inserted: false, error: null },
    ]);

    await importFile(["apple", "apple"].join("\n"));

    // 两条都交给批量命令；后端按 lower(word) 唯一索引判重
    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    expect(mockEnrichWord).toHaveBeenCalledTimes(1);
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个重复跳过"));
  });

  it("counts a rejected batch as failed rows and continues", async () => {
    mockAddWordsBatch.mockRejectedValueOnce(new Error("db down"));

    await importFile("hello,你好");

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    expect(mockEnrichWord).not.toHaveBeenCalled();
    // 整块失败按行计入失败并给出可重试汇总
    expect(showMessage).toHaveBeenCalledWith("info", expect.stringContaining("1 个失败（可重试）"));
    expect(refresh).toHaveBeenCalled();
  });

  // ── E3：失败计数进汇总 ──

  it("counts batch result errors in the summary and downgrades the message to info", async () => {
    mockAddWordsBatch.mockResolvedValueOnce([
      { id: 1, inserted: true, error: null },
      { id: null, inserted: false, error: "invalid word" },
    ]);

    await importFile(["alpha,你好", "beta,你好"].join("\n"));

    const message = showMessage.mock.calls.find(([type]) => type === "info");
    expect(message?.[1]).toContain("1 个新词");
    expect(message?.[1]).toContain("1 个失败（可重试）");
  });

  // ── 分块批量调用 ──

  it("splits rows into 50-row batches", async () => {
    const lines = Array.from({ length: 51 }, (_, i) => `word${i},,释义${i}`);

    await importFile(lines.join("\n"));

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(2);
    expect((mockAddWordsBatch.mock.calls[0][0] as unknown[]).length).toBe(50);
    expect((mockAddWordsBatch.mock.calls[1][0] as unknown[]).length).toBe(1);
    // 51 行均有释义，不触发补全
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("success", "导入完成：51 个新词");
  });

  // ── E5：空字段补全视为失败 ──

  it("writes enrichment when phonetic and definition are both present", async () => {
    await importFile("apple");

    expect(mockUpdateWordEnrichment).toHaveBeenCalledWith(1, {
      phonetic: "/ˈæpl/",
      definition: "苹果",
      notes: expect.any(String),
      level: "CET-4",
    });
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个已自动补全"));
  });

  it("treats a whitespace-only phonetic as a failed enrichment (no db write)", async () => {
    // 空 phonetic 会经 buildEnrichmentUpdate 写成空串、覆盖刚插入行的音标
    mockEnrichWord.mockResolvedValue({ ...enriched, phonetic: "   " });

    await importFile("apple");

    // 词本身仍导入成功（带占位释义，可后续重试补全）
    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("1 个补全失败（可重试）"),
    );
  });

  it("treats an empty definition as a failed enrichment (no db write)", async () => {
    mockEnrichWord.mockResolvedValue({ ...enriched, definition: "" });

    await importFile("apple");

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("1 个补全失败（可重试）"),
    );
  });

  it("counts a null enrichment result as failed (no db write)", async () => {
    // enrichWord 契约：请求/解析失败时返回 null——必须计入补全失败，
    // 否则补全全灭时汇总仍报 success
    mockEnrichWord.mockResolvedValue(null);

    await importFile("apple");

    expect(mockAddWordsBatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("1 个补全失败（可重试）"),
    );
  });
});
