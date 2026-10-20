import { describe, expect, it } from "vitest";
import { REVIEW_STATUS } from "./constants";
import {
  asciiLower,
  buildEnrichmentNotes,
  buildEnrichmentUpdate,
  buildNewWordInput,
  hasUsableEnrichment,
  isWordLevel,
  needsEnrichment,
  PENDING_DEFINITION,
  PRECHECK_CANDIDATE_LIMIT,
  parseNotes,
  toWordLevel,
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

describe("toWordLevel", () => {
  it("returns the level for valid values", () => {
    expect(toWordLevel("CET-4")).toBe("CET-4");
    expect(toWordLevel("超纲")).toBe("超纲");
  });

  it("returns null for out-of-enum strings (LLM 越界值)", () => {
    // EnrichedWordSchema.level 是宽松 z.string()，越界值在这里归一为 null
    expect(toWordLevel("GRE")).toBeNull();
    expect(toWordLevel("B2")).toBeNull(); // CEFR 码不是词汇等级标签
    expect(toWordLevel("cet-4")).toBeNull(); // case sensitive
    expect(toWordLevel("")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(toWordLevel(null)).toBeNull();
    expect(toWordLevel(undefined)).toBeNull();
    expect(toWordLevel(42)).toBeNull();
    expect(toWordLevel({ level: "CET-4" })).toBeNull();
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
      // LLM 未给出等级 → null（Rust 侧仅空值回填，已有等级优先）
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

  it("normalizes an out-of-enum level to null (写库前归一化)", () => {
    // LLM 可能输出 11 值之外的等级（如 GRE）：富化数据照常保留，等级归一为 null
    const update = buildEnrichmentUpdate({
      phonetic: "/ˈæbstrækt/",
      definition: "抽象的",
      collocations: "abstract concept",
      example: "It is an abstract idea.",
      level: "GRE",
    });
    expect(update.level).toBeNull();
    // 其余字段不受越界等级影响
    expect(update.phonetic).toBe("/ˈæbstrækt/");
    expect(update.definition).toBe("抽象的");
    expect(update.notes).toContain("搭配: abstract concept");
    expect(update.notes).toContain("例句: It is an abstract idea.");
  });

  it("normalizes a CEFR-coded level to null (口径不同)", () => {
    // difficulty_level 体系的码（B1+ 等）不是词汇等级标签
    const update = buildEnrichmentUpdate({
      phonetic: "/w/",
      definition: "词",
      collocations: "",
      example: "",
      level: "B1+",
    });
    expect(update.level).toBeNull();
  });
});

// ── asciiLower ──

describe("asciiLower", () => {
  it("folds ASCII upper-case letters only", () => {
    expect(asciiLower("Hello")).toBe("hello");
    expect(asciiLower("HeLLo WORLD")).toBe("hello world");
    expect(asciiLower("already lower")).toBe("already lower");
  });

  it("leaves non-ASCII characters untouched (SQLite lower() 语义)", () => {
    // SQLite 的 lower() 只折叠 ASCII：带变音符号的大写字母必须原样保留，
    // 否则与后端 lower(word) = lower(?) 的存在性比对口径不一致
    expect(asciiLower("ÉCOLE")).toBe("École");
    expect(asciiLower("ÜBER")).toBe("Über");
    expect(asciiLower("straße")).toBe("straße");
  });

  it("handles the empty string", () => {
    expect(asciiLower("")).toBe("");
  });
});

// ── hasUsableEnrichment ──

describe("hasUsableEnrichment", () => {
  it("returns true when both core fields are present", () => {
    expect(hasUsableEnrichment({ phonetic: "/ˈæpl/", definition: "苹果" })).toBe(true);
  });

  it("returns false when the phonetic is empty", () => {
    expect(hasUsableEnrichment({ phonetic: "", definition: "苹果" })).toBe(false);
  });

  it("returns false when the definition is empty", () => {
    expect(hasUsableEnrichment({ phonetic: "/ˈæpl/", definition: "" })).toBe(false);
  });

  it("treats whitespace-only fields as unusable", () => {
    expect(hasUsableEnrichment({ phonetic: "   ", definition: "苹果" })).toBe(false);
    expect(hasUsableEnrichment({ phonetic: "/ˈæpl/", definition: "\t\n " })).toBe(false);
  });
});

// ── buildNewWordInput ──

describe("buildNewWordInput", () => {
  it("builds a new-word payload with null defaults for optional fields", () => {
    const input = buildNewWordInput({
      word: "hello",
      definition: "你好",
      source_type: "manual",
    });
    expect(input).toEqual({
      word: "hello",
      phonetic: null,
      definition: "你好",
      level: null,
      source_type: "manual",
      source_text: null,
      notes: null,
      review_status: REVIEW_STATUS.new,
    });
    // 插入载荷不含 id / created_at（由数据库生成）
    expect(Object.keys(input)).not.toContain("id");
    expect(Object.keys(input)).not.toContain("created_at");
  });

  it("passes source fields through unchanged", () => {
    const input = buildNewWordInput({
      word: "word",
      phonetic: "/wɜːrd/",
      definition: "词；单词",
      source_type: "reading",
      source_text: "context text",
      notes: "音标: /wɜːrd/\n释义: 词；单词",
    });
    expect(input.phonetic).toBe("/wɜːrd/");
    expect(input.source_type).toBe("reading");
    expect(input.source_text).toBe("context text");
    expect(input.notes).toBe("音标: /wɜːrd/\n释义: 词；单词");
    expect(input.review_status).toBe("new");
  });

  it("normalizes a valid level and passes it through", () => {
    expect(
      buildNewWordInput({
        word: "apple",
        definition: "苹果",
        level: "CET-4",
        source_type: "import",
      }).level,
    ).toBe("CET-4");
  });

  it("normalizes an invalid level to null (写库前清洗)", () => {
    // LLM 输出 / CSV 列 / 表单值均属不可信来源：越界值与非字符串统一归一为 null
    expect(
      buildNewWordInput({ word: "apple", definition: "苹果", level: "GRE", source_type: "import" })
        .level,
    ).toBeNull();
    expect(
      buildNewWordInput({ word: "apple", definition: "苹果", level: "", source_type: "import" })
        .level,
    ).toBeNull();
    expect(
      buildNewWordInput({ word: "apple", definition: "苹果", level: 42, source_type: "import" })
        .level,
    ).toBeNull();
    expect(
      buildNewWordInput({
        word: "apple",
        definition: "苹果",
        level: undefined,
        source_type: "import",
      }).level,
    ).toBeNull();
  });

  it("keeps explicit nulls for optional fields", () => {
    const input = buildNewWordInput({
      word: "apple",
      phonetic: null,
      definition: "苹果",
      level: null,
      source_type: "import",
      source_text: null,
      notes: null,
    });
    expect(input.phonetic).toBeNull();
    expect(input.source_text).toBeNull();
    expect(input.notes).toBeNull();
    expect(input.level).toBeNull();
  });

  it("exposes the precheck candidate limit aligned with the server cap", () => {
    expect(PRECHECK_CANDIDATE_LIMIT).toBe(500);
  });
});
