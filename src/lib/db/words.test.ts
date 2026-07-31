import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addWord, deleteWord, getWords, updateWordEnrichment, updateWordLevel } from "./words";

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
    expect(invoke).toHaveBeenCalledWith("db_get_words", { limit: null, offset: null });
    expect(result).toEqual([]);
  });

  it("getWords passes limit and offset when provided", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getWords(100, 50);
    expect(invoke).toHaveBeenCalledWith("db_get_words", { limit: 100, offset: 50 });
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
    });
  });
});
