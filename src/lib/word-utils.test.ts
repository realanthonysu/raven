import { describe, expect, it } from "vitest";
import {
  buildEnrichmentNotes,
  buildEnrichmentUpdate,
  isWordLevel,
  needsEnrichment,
  PENDING_DEFINITION,
  parseNotes,
} from "./word-utils";

describe("buildEnrichmentNotes", () => {
  it("builds notes from all fields", () => {
    const result = buildEnrichmentNotes({
      phonetic: "/wɜːrd/",
      definition: "词；单词",
      collocations: "break the ice",
      example: "He broke the ice.",
    });
    expect(result).toContain("音标: /wɜːrd/");
    expect(result).toContain("释义: 词；单词");
    expect(result).toContain("搭配: break the ice");
    expect(result).toContain("例句: He broke the ice.");
  });

  it("returns null when all fields are empty", () => {
    expect(
      buildEnrichmentNotes({ phonetic: null, definition: "", collocations: "", example: "" }),
    ).toBeNull();
  });

  it("returns partial notes when some fields are empty", () => {
    const result = buildEnrichmentNotes({
      phonetic: "/test/",
      definition: "test",
      collocations: "",
      example: "",
    });
    expect(result).toContain("音标: /test/");
    expect(result).toContain("释义: test");
    expect(result).not.toContain("搭配");
    expect(result).not.toContain("例句");
  });

  it("handles phonetic as null", () => {
    const result = buildEnrichmentNotes({
      phonetic: null,
      definition: "test def",
      collocations: "",
      example: "",
    });
    expect(result).toBe("释义: test def");
  });
});

describe("parseNotes", () => {
  it("parses collocations and example from standard format", () => {
    const result = parseNotes("搭配: break the ice\n例句: He broke the ice.");
    expect(result.collocations).toBe("break the ice");
    expect(result.example).toBe("He broke the ice.");
  });

  it("parses with full-width colon", () => {
    const result = parseNotes("搭配：make a difference\n例句：She made a difference.");
    expect(result.collocations).toBe("make a difference");
    expect(result.example).toBe("She made a difference.");
  });

  it("parses variant labels (常见搭配, 举例)", () => {
    const result = parseNotes("常见搭配: run out of\n举例: We ran out of time.");
    expect(result.collocations).toBe("run out of");
    expect(result.example).toBe("We ran out of time.");
  });

  it("returns nulls for null input", () => {
    expect(parseNotes(null)).toEqual({ collocations: null, example: null });
  });

  it("returns nulls when no patterns match", () => {
    expect(parseNotes("just some random text")).toEqual({
      collocations: null,
      example: null,
    });
  });

  it("handles notes with only collocations", () => {
    const result = parseNotes("搭配: get along with");
    expect(result.collocations).toBe("get along with");
    expect(result.example).toBeNull();
  });

  it("handles notes with only example", () => {
    const result = parseNotes("例句: The quick brown fox.");
    expect(result.collocations).toBeNull();
    expect(result.example).toBe("The quick brown fox.");
  });
});

describe("isWordLevel", () => {
  it("returns true for valid levels", () => {
    expect(isWordLevel("CET-4")).toBe(true);
    expect(isWordLevel("CET-6")).toBe(true);
    expect(isWordLevel("TEM-4")).toBe(true);
    expect(isWordLevel("TEM-8")).toBe(true);
    // 级别体系扩展后的新增值（小学…超纲共 11 值）
    expect(isWordLevel("小学")).toBe(true);
    expect(isWordLevel("高考")).toBe(true);
    expect(isWordLevel("考研")).toBe(true);
    expect(isWordLevel("雅思")).toBe(true);
    expect(isWordLevel("超纲")).toBe(true);
  });

  it("returns false for invalid levels", () => {
    expect(isWordLevel("invalid")).toBe(false);
    expect(isWordLevel("")).toBe(false);
    expect(isWordLevel("cet-4")).toBe(false); // case sensitive
  });
});

// ── needsEnrichment / buildEnrichmentUpdate / PENDING_DEFINITION ──

describe("needsEnrichment", () => {
  it("flags placeholder definition as needing enrichment", () => {
    expect(needsEnrichment({ definition: PENDING_DEFINITION, phonetic: "/w/" })).toBe(true);
  });

  it("flags missing phonetic as needing enrichment", () => {
    expect(needsEnrichment({ definition: "释义", phonetic: null })).toBe(true);
  });

  it("returns false for complete entries", () => {
    expect(needsEnrichment({ definition: "释义", phonetic: "/w/" })).toBe(false);
  });
});

describe("buildEnrichmentUpdate", () => {
  it("builds the update payload with fallbacks for empty fields", () => {
    const update = buildEnrichmentUpdate({
      phonetic: "/wɜːrd/",
      definition: "",
      collocations: "break the ice",
      example: "He broke the ice.",
    });
    expect(update).toEqual({
      phonetic: "/wɜːrd/",
      definition: PENDING_DEFINITION,
      notes: expect.stringContaining("搭配: break the ice"),
      // LLM 未给出等级 → null（Rust 侧 COALESCE 保留现有等级）
      level: null,
    });
  });

  it("passes the LLM-labeled level through to the update payload", () => {
    const update = buildEnrichmentUpdate({
      phonetic: "/nɪˈɡoʊʃieɪt/",
      definition: "谈判",
      collocations: "negotiate a deal",
      example: "We negotiated a deal.",
      level: "CET-4",
    });
    expect(update.level).toBe("CET-4");
    // 其余字段结构不变（notes 组装逻辑保持原样）
    expect(update.phonetic).toBe("/nɪˈɡoʊʃieɪt/");
    expect(update.notes).toContain("搭配: negotiate a deal");
    expect(update.notes).toContain("例句: We negotiated a deal.");
  });

  it("keeps definition-derived notes when only definition is present", () => {
    const update = buildEnrichmentUpdate({
      phonetic: "",
      definition: "释义",
      collocations: "",
      example: "",
    });
    expect(update.notes).toContain("释义: 释义");
    expect(update.definition).toBe("释义");
    expect(update.level).toBeNull();
  });
});
