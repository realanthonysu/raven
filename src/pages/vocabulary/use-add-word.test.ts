/**
 * use-add-word hook 行为测试。
 *
 * 覆盖后端存在性预检（E2：窄查询 + 大小写不敏感精确比对、模糊匹配放行、
 * 预检失败回落完整流程）与表单提交主路径。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRECHECK_CANDIDATE_LIMIT } from "@/lib/word-utils";
import { useAddWord } from "./use-add-word";

const mockAddWord = vi.fn();
const mockGetWords = vi.fn();
const mockEnrichWord = vi.fn();

vi.mock("@/lib/db", () => ({
  addWord: (...args: unknown[]) => mockAddWord(...args),
  getWords: (...args: unknown[]) => mockGetWords(...args),
}));

vi.mock("@/services/vocabulary-enrichment", () => ({
  enrichWord: (...args: unknown[]) => mockEnrichWord(...args),
}));

// ─── Helpers ───────────────────────────────────────────────────────

const showMessage = vi.fn();
const refresh = vi.fn();

function setup() {
  return renderHook(() => useAddWord({ refresh, showMessage }));
}

interface FormValues {
  word?: string;
  phonetic?: string;
  definition?: string;
  level?: string;
}

/** 填写表单（独立 act 确保提交读到最新受控状态）后提交 */
async function fillAndSubmit(
  result: { current: ReturnType<typeof useAddWord> },
  values: FormValues,
) {
  await act(async () => {
    if (values.word !== undefined) result.current.setFormWord(values.word);
    if (values.phonetic !== undefined) result.current.setFormPhonetic(values.phonetic);
    if (values.definition !== undefined) result.current.setFormDefinition(values.definition);
    if (values.level !== undefined) result.current.setFormLevel(values.level);
  });
  await act(async () => {
    await result.current.handleAddWord();
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("useAddWord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddWord.mockResolvedValue({ lastInsertId: 1 });
    mockGetWords.mockResolvedValue([]);
    mockEnrichWord.mockResolvedValue(null);
  });

  // ── E2：后端存在性预检 ──

  it("prechecks the notebook with a wide candidate query before adding", async () => {
    const { result } = setup();
    await fillAndSubmit(result, { word: "hello", definition: "你好" });

    expect(mockGetWords).toHaveBeenCalledWith(PRECHECK_CANDIDATE_LIMIT, 0, "hello");
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({ word: "hello", definition: "你好" }),
    );
    expect(showMessage).toHaveBeenCalledWith("success", '已添加 "hello"');
    expect(refresh).toHaveBeenCalled();
  });

  it("does not add when the precheck finds the exact word (case-insensitive)", async () => {
    mockGetWords.mockResolvedValue([{ word: "Hello" }]);

    const { result } = setup();
    await fillAndSubmit(result, { word: "hello" });

    expect(mockAddWord).not.toHaveBeenCalled();
    expect(mockEnrichWord).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("info", '"hello" 已存在于生词本中，未重复添加');
    // 表单保留，用户可改词重试
    expect(result.current.formWord).toBe("hello");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("proceeds when the precheck only fuzzily matches similar words", async () => {
    // search 是模糊 LIKE：有相近候选不代表词条已存在，必须精确比对
    mockGetWords.mockResolvedValue([{ word: "helloworld" }, { word: "helloes" }]);
    mockEnrichWord.mockResolvedValue({
      phonetic: "/həˈloʊ/",
      definition: "你好",
      collocations: "",
      example: "",
      level: null,
    });

    const { result } = setup();
    await fillAndSubmit(result, { word: "hello" });

    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(mockEnrichWord).toHaveBeenCalledWith("hello");
  });

  it("falls back to the full flow when the precheck fails", async () => {
    // 预检异常按未命中处理，由后端 add_word 幂等兜底
    mockGetWords.mockRejectedValue(new Error("db down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = setup();
    await fillAndSubmit(result, { word: "hello", definition: "你好" });

    expect(mockAddWord).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "Vocabulary existence precheck failed:",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  // ── 表单主路径 ──

  it("adds with form values and clears the form on success", async () => {
    const { result } = setup();
    await fillAndSubmit(result, {
      word: "  ephemeral  ",
      phonetic: "/ɪˈfemərəl/",
      definition: "短暂的",
      level: "CET-6",
    });

    expect(mockAddWord).toHaveBeenCalledWith({
      word: "ephemeral",
      phonetic: "/ɪˈfemərəl/",
      definition: "短暂的",
      level: "CET-6",
      source_type: "manual",
      source_text: null,
      notes: null,
      review_status: "new",
    });
    expect(result.current.formWord).toBe("");
    expect(result.current.formPhonetic).toBe("");
    expect(result.current.formDefinition).toBe("");
    expect(result.current.formLevel).toBe("");
  });

  it("enriches via LLM when the definition is left empty", async () => {
    mockEnrichWord.mockResolvedValue({
      phonetic: "/ˈæp.əl/",
      definition: "苹果",
      collocations: "apple pie",
      example: "An apple a day.",
      level: "CET-4",
    });

    const { result } = setup();
    await fillAndSubmit(result, { word: "apple" });

    expect(mockEnrichWord).toHaveBeenCalledWith("apple");
    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({
        word: "apple",
        phonetic: "/ˈæp.əl/",
        definition: "苹果",
        notes: expect.stringContaining("搭配"),
      }),
    );
  });

  it("falls back to the pending definition when enrichment returns null", async () => {
    mockEnrichWord.mockResolvedValue(null);

    const { result } = setup();
    await fillAndSubmit(result, { word: "rareword" });

    expect(mockAddWord).toHaveBeenCalledWith(
      expect.objectContaining({ word: "rareword", phonetic: null, definition: "待补充" }),
    );
  });

  it("ignores an empty word without touching the notebook", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleAddWord();
    });

    expect(mockGetWords).not.toHaveBeenCalled();
    expect(mockAddWord).not.toHaveBeenCalled();
  });

  it("shows an error and keeps the form when addWord fails", async () => {
    mockAddWord.mockRejectedValue(new Error("db down"));

    const { result } = setup();
    await fillAndSubmit(result, { word: "hello", definition: "你好" });

    expect(showMessage).toHaveBeenCalledWith("error", "添加失败，请重试");
    expect(result.current.formWord).toBe("hello");
    expect(result.current.adding).toBe(false);
  });
});
