import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addWord,
  addWordsBatch,
  deleteWord,
  getWordStats,
  getWords,
  getWordsPage,
  updateWordEnrichment,
  updateWordLevel,
} from "./words";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("words db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getWords calls invoke", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const result = await getWords();
    expect(invoke).toHaveBeenCalledWith("db_get_words", {
      limit: null,
      offset: null,
      search: null,
    });
    expect(result).toEqual([]);
  });

  it("getWords passes limit and offset when provided", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getWords(100, 50, "apple");
    expect(invoke).toHaveBeenCalledWith("db_get_words", {
      limit: 100,
      offset: 50,
      search: "apple",
    });
  });

  it("getWordsPage calls invoke with pagination/search/level params", async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [], total: 0 });
    const result = await getWordsPage({
      limit: 50,
      offset: 100,
      search: " apple ",
      level: "CET-4",
    });
    expect(invoke).toHaveBeenCalledWith("db_get_words_page", {
      limit: 50,
      offset: 100,
      search: "apple",
      level: "CET-4",
    });
    expect(result).toEqual({ items: [], total: 0 });
  });

  it("getWordsPage maps omitted optional params to null", async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [], total: 0 });
    await getWordsPage({ limit: 20 });
    expect(invoke).toHaveBeenCalledWith("db_get_words_page", {
      limit: 20,
      offset: null,
      search: null,
      level: null,
    });
  });

  it("getWordStats calls invoke without params", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const result = await getWordStats();
    expect(invoke).toHaveBeenCalledWith("db_get_word_stats");
    expect(result).toEqual([]);
  });

  it("addWord calls invoke with word data", async () => {
    vi.mocked(invoke).mockResolvedValue(1);
    const result = await addWord({
      word: "ephemeral",
      phonetic: "/ɪˈfemərəl/",
      definition: "短暂的",
      level: "CET-6",
      source_type: "reading",
      source_text: "test",
      notes: "test notes",
      review_status: "new",
      review_count: 0,
      next_review_at: null,
    });
    expect(invoke).toHaveBeenCalledWith(
      "db_add_word",
      expect.objectContaining({
        input: expect.objectContaining({ word: "ephemeral" }),
      }),
    );
    expect(result).toBe(1);
  });

  it("addWordsBatch maps inputs and calls invoke once", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { id: 1, inserted: true, error: null },
      { id: 2, inserted: false, error: null },
    ]);
    const result = await addWordsBatch([
      {
        word: "alpha",
        phonetic: "/ˈælfə/",
        definition: "第一个",
        level: "CET-4",
        source_type: "manual",
        source_text: null,
        notes: null,
        review_status: "new",
        review_count: 0,
        next_review_at: null,
      },
      {
        word: "beta",
        phonetic: null,
        definition: "第二个",
        level: null,
        source_type: null,
        source_text: null,
        notes: null,
        review_status: "new",
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("db_add_words_batch", {
      inputs: [
        expect.objectContaining({ word: "alpha", review_status: "new" }),
        expect.objectContaining({ word: "beta", review_status: "new" }),
      ],
    });
    expect(result).toEqual([
      { id: 1, inserted: true, error: null },
      { id: 2, inserted: false, error: null },
    ]);
  });

  it("deleteWord calls invoke with correct id", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await deleteWord(5);
    expect(invoke).toHaveBeenCalledWith("db_delete_word", { id: 5 });
  });

  it("updateWordLevel calls invoke with correct params", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await updateWordLevel(3, "CET-4");
    expect(invoke).toHaveBeenCalledWith("db_update_word_level", { id: 3, level: "CET-4" });
  });

  it("updateWordEnrichment calls invoke with correct params", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await updateWordEnrichment(2, {
      phonetic: "/test/",
      definition: "test def",
      notes: "test notes",
    });
    expect(invoke).toHaveBeenCalledWith("db_update_word_enrichment", {
      id: 2,
      phonetic: "/test/",
      definition: "test def",
      notes: "test notes",
      level: null,
    });
  });
});
