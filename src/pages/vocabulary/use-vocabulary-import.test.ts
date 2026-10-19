/**
 * use-vocabulary-import hook 行为测试。
 *
 * 覆盖 CSV 表头判定（E1：只看首个字段）、导入去重（E2：全量基线 + 已存在
 * 行不覆盖旧数据）、失败计数汇总（E3）与空字段补全失败（E5）。
 * db 与 LLM 补全服务 mock，CSV 解析与批处理走真实实现。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "@/types";
import { useVocabularyImport } from "./use-vocabulary-import";

const mockAddWord = vi.fn();
const mockGetWords = vi.fn();
const mockUpdateWordEnrichment = vi.fn();
const mockEnrichWord = vi.fn();

vi.mock("@/lib/db", () => ({
  addWord: (...args: unknown[]) => mockAddWord(...args),
  getWords: (...args: unknown[]) => mockGetWords(...args),
  updateWordEnrichment: (...args: unknown[]) => mockUpdateWordEnrichment(...args),
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Fixtures ──────────────────────────────────────────────────────

function makeWord(word: string, overrides: Partial<Word> = {}): Word {
  return {
    id: 1,
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

// ─── Tests ─────────────────────────────────────────────────────────

describe("useVocabularyImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddWord.mockResolvedValue(1);
    mockGetWords.mockResolvedValue([]);
    mockUpdateWordEnrichment.mockResolvedValue(undefined);
    mockEnrichWord.mockResolvedValue(enriched);
  });

  // ── E1：表头判定只看首个字段 ──

  it("imports a first data line that merely contains 'word' as a substring", async () => {
    // "sword" 含子串 "word"：整行 includes 判定会把首行数据误判为表头而整行丢弃
    await importFile(["sword,/sɔːd/,n. 剑", "shield,/ʃiːld/,n. 盾"].join("\n"));

    expect(mockAddWord).toHaveBeenCalledTimes(2);
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({ word: "sword", phonetic: "/sɔːd/" }),
    );
    expect(mockAddWord).toHaveBeenCalledWith(expect.objectContaining({ word: "shield" }));
    // 两行均有释义，不触发补全
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("success", "导入完成：2 个新词");
  });

  it("skips a genuine header row whose first field is exactly 'word'", async () => {
    await importFile(["word,phonetic,definition,level", "hello,/həˈloʊ/,你好,CET-4"].join("\n"));

    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({ word: "hello", phonetic: "/həˈloʊ/", definition: "你好" }),
    );
    expect(mockEnrichWord).not.toHaveBeenCalled();
  });

  // ── E2：全量去重基线 ──

  it("builds the dedup baseline from one full getWords() call", async () => {
    await importFile("apple");

    expect(mockGetWords).toHaveBeenCalledWith();
    expect(mockGetWords).toHaveBeenCalledTimes(1);
  });

  it("skips words already in the notebook without overwriting their data", async () => {
    // 已存在行带旧音标与待补充释义：若被当作新词处理会先 addWord 再补全覆盖旧数据
    mockGetWords.mockResolvedValue([
      makeWord("hello", { id: 7, phonetic: "/OLD/", definition: "待补充", notes: "旧笔记" }),
    ]);

    await importFile(["hello", "world,,世界"].join("\n"));

    // 只有 world 被插入；hello 计入重复跳过
    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockAddWord).toHaveBeenCalledWith(expect.objectContaining({ word: "world" }));
    expect(mockAddWord).not.toHaveBeenCalledWith(expect.objectContaining({ word: "hello" }));
    // 已存在行绝不触发补全写库（旧音标/笔记保留）
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个重复跳过"));
  });

  it("deduplicates repeated lines within the same file", async () => {
    await importFile(["apple", "apple"].join("\n"));

    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockEnrichWord).toHaveBeenCalledTimes(1);
    expect(showMessage).toHaveBeenCalledWith("success", expect.stringContaining("1 个重复跳过"));
  });

  it("aborts the import with an error when the full word list read fails", async () => {
    // 全量读取失败必须中止：拿搜索子集兜底会静默产生重复行
    mockGetWords.mockRejectedValue(new Error("db down"));

    await importFile("hello,你好");

    expect(mockAddWord).not.toHaveBeenCalled();
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("error", expect.stringContaining("导入失败"));
    expect(showMessage).toHaveBeenCalledWith("error", expect.stringContaining("db down"));
    expect(refresh).not.toHaveBeenCalled();
  });

  // ── E3：失败计数进汇总 ──

  it("counts failed rows in the summary and downgrades the message to info", async () => {
    mockAddWord.mockRejectedValueOnce(new Error("write failed")).mockResolvedValueOnce(2);

    await importFile(["alpha", "beta"].join("\n"));

    expect(mockAddWord).toHaveBeenCalledTimes(2);
    const message = showMessage.mock.calls.find(([type]) => type === "info");
    expect(message?.[1]).toContain("1 个新词");
    expect(message?.[1]).toContain("1 个失败（可重试）");
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
    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("1 个补全失败（可重试）"),
    );
  });

  it("treats an empty definition as a failed enrichment (no db write)", async () => {
    mockEnrichWord.mockResolvedValue({ ...enriched, definition: "" });

    await importFile("apple");

    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockUpdateWordEnrichment).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("1 个补全失败（可重试）"),
    );
  });
});
