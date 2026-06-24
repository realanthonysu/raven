import { describe, expect, it } from "vitest";
import {
  extractJson,
  matchAnswer,
  parseCorrectionJson,
  parseSections,
  splitSentences,
} from "./parse-utils";

/**
 * parseCorrectionJson 测试套件。
 *
 * 覆盖 LLM 返回 JSON 的三种格式场景：
 * 1. 纯 JSON（理想情况）
 * 2. markdown 代码块包裹（有/无语言标签）
 * 3. JSON 前后混有解释性文字
 *
 * 以及异常场景：无效输入、空字符串、格式错误的代码块。
 */
describe("parseCorrectionJson", () => {
  it("parses valid JSON directly", () => {
    const input = JSON.stringify({
      corrected_text: "Hello world.",
      corrections: [],
      summary: "No errors.",
    });
    expect(parseCorrectionJson(input)).toEqual({
      corrected_text: "Hello world.",
      corrections: [],
      summary: "No errors.",
    });
  });

  it("parses JSON inside markdown code block", () => {
    const json = JSON.stringify({
      corrected_text: "Fixed text",
      corrections: [],
      summary: "ok",
    });
    const input = `\`\`\`json\n${json}\n\`\`\``;
    expect(parseCorrectionJson(input)?.corrected_text).toBe("Fixed text");
  });

  it("parses JSON inside markdown code block without language tag", () => {
    const json = JSON.stringify({
      corrected_text: "No lang tag",
      corrections: [],
      summary: "ok",
    });
    const input = `\`\`\`\n${json}\n\`\`\``;
    expect(parseCorrectionJson(input)?.corrected_text).toBe("No lang tag");
  });

  it("parses JSON surrounded by extra text", () => {
    const json = '{"corrected_text":"Hi","corrections":[],"summary":"ok"}';
    const input = `Here is the result:\n${json}\nDone.`;
    expect(parseCorrectionJson(input)?.corrected_text).toBe("Hi");
  });

  it("returns null for invalid input", () => {
    expect(parseCorrectionJson("not json at all")).toBeNull();
  });

  it("returns null for malformed JSON in code block", () => {
    expect(parseCorrectionJson("```json\n{broken\n```")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCorrectionJson("")).toBeNull();
  });

  it("parses JSON with corrections array", () => {
    const input = JSON.stringify({
      corrected_text: "She goes to school.",
      corrections: [
        {
          original: "She go to school.",
          corrected: "She goes to school.",
          category: "语法",
          explanation: "主谓一致",
        },
      ],
      summary: "One error found.",
    });
    const result = parseCorrectionJson(input);
    expect(result).not.toBeNull();
    expect(result?.corrections).toHaveLength(1);
    expect(result?.corrections[0].category).toBe("语法");
  });

  it("parses JSON wrapped in code block with surrounding text", () => {
    const json = JSON.stringify({
      corrected_text: "Done",
      corrections: [],
      summary: "ok",
    });
    const input = `Here is the correction:\n\`\`\`json\n${json}\n\`\`\`\nHope this helps!`;
    expect(parseCorrectionJson(input)?.corrected_text).toBe("Done");
  });

  it("parses valid JSON that happens to contain braces in values", () => {
    const input = JSON.stringify({
      corrected_text: "Use {brackets} carefully.",
      corrections: [],
      summary: "ok",
    });
    const result = parseCorrectionJson(input);
    expect(result).not.toBeNull();
    expect(result?.corrected_text).toBe("Use {brackets} carefully.");
  });
});

/**
 * matchAnswer 测试套件。
 *
 * 按题型分组测试比对逻辑：
 * - fill（填空题）：精确匹配（trim + toLowerCase），单个词/短语
 * - correct（改错题）/ rewrite（重写题）：归一化空白后匹配，句子级答案
 *
 * 每个题型组覆盖：精确匹配、大小写不敏感、空白处理、内容不匹配。
 * 最后的 edge cases 组覆盖空字符串和纯空白字符串。
 */
describe("matchAnswer", () => {
  describe("fill type", () => {
    it("matches exact answers case insensitively", () => {
      expect(matchAnswer("went", "went", "fill")).toBe(true);
      expect(matchAnswer("Went", "went", "fill")).toBe(true);
      expect(matchAnswer("WENT", "went", "fill")).toBe(true);
    });

    it("rejects mismatched answers", () => {
      expect(matchAnswer("go", "went", "fill")).toBe(false);
      expect(matchAnswer("walked", "went", "fill")).toBe(false);
    });

    it("trims whitespace before comparing", () => {
      expect(matchAnswer("  went  ", "went", "fill")).toBe(true);
      expect(matchAnswer("went", "  went  ", "fill")).toBe(true);
    });

    it("rejects answers with extra internal whitespace", () => {
      // fill type uses strict equality after trim+lowercase, no normalization
      expect(matchAnswer("we nt", "went", "fill")).toBe(false);
    });
  });

  describe("correct type", () => {
    it("matches exact answers case insensitively", () => {
      expect(matchAnswer("He goes to school.", "He goes to school.", "correct")).toBe(true);
      expect(matchAnswer("he goes to school.", "He goes to school.", "correct")).toBe(true);
    });

    it("matches answers with different whitespace", () => {
      expect(matchAnswer("He  goes  to  school.", "He goes to school.", "correct")).toBe(true);
      expect(matchAnswer("He goes to school.", "He  goes  to  school.", "correct")).toBe(true);
    });

    it("matches answers with newlines vs spaces", () => {
      expect(matchAnswer("He\ngoes\nto school.", "He goes to school.", "correct")).toBe(true);
    });

    it("trims leading and trailing whitespace", () => {
      expect(matchAnswer("  He goes to school.  ", "He goes to school.", "correct")).toBe(true);
    });

    it("rejects mismatched content", () => {
      expect(matchAnswer("She goes to school.", "He goes to school.", "correct")).toBe(false);
    });

    it("ignores punctuation differences", () => {
      expect(
        matchAnswer(
          "good morning, how are you today",
          "Good morning. How are you today?",
          "correct",
        ),
      ).toBe(true);
      expect(matchAnswer("hello!", "hello", "correct")).toBe(true);
      expect(matchAnswer("it's here", "its here", "correct")).toBe(true);
    });
  });

  describe("rewrite type", () => {
    it("matches exact answers case insensitively", () => {
      expect(matchAnswer("She goes to school.", "She goes to school.", "rewrite")).toBe(true);
    });

    it("matches answers with different whitespace", () => {
      expect(matchAnswer("She  goes  to  school.", "She goes to school.", "rewrite")).toBe(true);
    });

    it("rejects mismatched content", () => {
      expect(matchAnswer("He goes home.", "She goes to school.", "rewrite")).toBe(false);
    });

    it("ignores punctuation differences", () => {
      expect(
        matchAnswer(
          "good morning, how are you today",
          "Good morning. How are you today?",
          "rewrite",
        ),
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("matches two empty strings", () => {
      expect(matchAnswer("", "", "fill")).toBe(true);
      expect(matchAnswer("", "", "correct")).toBe(true);
      expect(matchAnswer("", "", "rewrite")).toBe(true);
    });

    it("matches whitespace-only strings against empty strings", () => {
      expect(matchAnswer("   ", "", "fill")).toBe(true);
      expect(matchAnswer("", "   ", "correct")).toBe(true);
      expect(matchAnswer("  \n  ", "", "rewrite")).toBe(true);
    });

    it("handles strings with only whitespace on both sides", () => {
      expect(matchAnswer("   ", "   ", "fill")).toBe(true);
    });
  });
});

/**
 * extractJson 测试套件。
 *
 * 覆盖三级回退策略的各场景：
 * 1. 直接 JSON 解析
 * 2. 从 markdown 代码块中提取
 * 3. 从周围文本中用括号匹配提取
 * 4. 无效输入返回 null
 * 5. 带验证函数的场景
 */
describe("extractJson", () => {
  describe("direct JSON parse (Level 1)", () => {
    it("parses a plain JSON object", () => {
      const input = '{"name":"test","value":42}';
      expect(extractJson(input)).toEqual({ name: "test", value: 42 });
    });

    it("parses a plain JSON array", () => {
      const input = "[1,2,3]";
      expect(extractJson(input)).toEqual([1, 2, 3]);
    });
  });

  describe("code block extraction (Level 2)", () => {
    it("extracts JSON from ```json code block", () => {
      const input = '```json\n{"key":"value"}\n```';
      expect(extractJson(input)).toEqual({ key: "value" });
    });

    it("extracts JSON from ``` code block without language tag", () => {
      const input = '```\n{"key":"value"}\n```';
      expect(extractJson(input)).toEqual({ key: "value" });
    });

    it("extracts JSON array from code block", () => {
      const input = "```json\n[1, 2, 3]\n```";
      expect(extractJson(input)).toEqual([1, 2, 3]);
    });
  });

  describe("brace/bracket extraction (Level 3)", () => {
    it("extracts JSON object surrounded by text", () => {
      const input = 'Here is the result:\n{"ok":true}\nDone.';
      expect(extractJson(input)).toEqual({ ok: true });
    });

    it("extracts JSON array surrounded by text", () => {
      const input = "Result: [1,2,3] end";
      expect(extractJson(input)).toEqual([1, 2, 3]);
    });

    it("extracts the first valid JSON when surrounded by text", () => {
      const input = 'Prefix {"a":1} middle {"b":2} suffix';
      expect(extractJson(input)).toEqual({ a: 1 });
    });

    it("handles nested braces correctly", () => {
      const input = 'Result: {"outer":{"inner":42}} done';
      expect(extractJson(input)).toEqual({ outer: { inner: 42 } });
    });
  });

  describe("invalid input returns null", () => {
    it("returns null for empty string", () => {
      expect(extractJson("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(extractJson("   ")).toBeNull();
    });

    it("returns null for text with no JSON", () => {
      expect(extractJson("no json here at all")).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      expect(extractJson("{broken json")).toBeNull();
    });

    it("returns null for null/undefined-like input", () => {
      expect(extractJson(null as unknown as string)).toBeNull();
      expect(extractJson(undefined as unknown as string)).toBeNull();
    });
  });

  describe("with validation function", () => {
    interface TestData {
      name: string;
      count: number;
    }

    function isTestData(data: unknown): data is TestData {
      return (
        typeof data === "object" &&
        data !== null &&
        typeof (data as TestData).name === "string" &&
        typeof (data as TestData).count === "number"
      );
    }

    it("returns parsed data when validation passes", () => {
      const input = '{"name":"hello","count":5}';
      const result = extractJson(input, isTestData);
      expect(result).toEqual({ name: "hello", count: 5 });
    });

    it("returns null when validation fails", () => {
      const input = '{"name":"hello","count":"not a number"}';
      const result = extractJson(input, isTestData);
      expect(result).toBeNull();
    });

    it("falls back through levels with validation", () => {
      const input = '```json\n{"name":"ok","count":3}\n```';
      const result = extractJson(input, isTestData);
      expect(result).toEqual({ name: "ok", count: 3 });
    });

    it("returns null if all levels fail validation", () => {
      const input = 'text {"wrong":true} more';
      const result = extractJson(input, isTestData);
      expect(result).toBeNull();
    });
  });
});

/**
 * splitSentences test suite.
 *
 * Splits English text on sentence-ending punctuation (.!?)
 * followed by whitespace. Preserves punctuation at end of each sentence.
 */
describe("splitSentences", () => {
  it("splits a simple two-sentence string", () => {
    const result = splitSentences("Hello world. How are you?");
    expect(result).toEqual(["Hello world.", "How are you?"]);
  });

  it("splits on exclamation marks", () => {
    const result = splitSentences("Wow! That is great!");
    expect(result).toEqual(["Wow!", "That is great!"]);
  });

  it("handles a single sentence", () => {
    const result = splitSentences("Just one sentence.");
    expect(result).toEqual(["Just one sentence."]);
  });

  it("handles multiple punctuation types mixed", () => {
    const result = splitSentences("Is this okay? Yes! It is. Great.");
    expect(result).toEqual(["Is this okay?", "Yes!", "It is.", "Great."]);
  });

  it("trims leading and trailing whitespace from sentences", () => {
    const result = splitSentences("  Hello.   World.  ");
    expect(result).toEqual(["Hello.", "World."]);
  });

  it("filters out empty strings from split", () => {
    const result = splitSentences("Hello.  ");
    expect(result).toEqual(["Hello."]);
  });

  it("returns empty array for empty string", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(splitSentences("   ")).toEqual([]);
  });

  it("handles text with no sentence-ending punctuation", () => {
    const result = splitSentences("no punctuation here");
    expect(result).toEqual(["no punctuation here"]);
  });

  it("handles consecutive sentences with varying whitespace", () => {
    const result = splitSentences("One.  Two.   Three.");
    expect(result).toEqual(["One.", "Two.", "Three."]);
  });
});

/**
 * parseSections test suite.
 *
 * Parses LLM markdown output split by ## headers into key-value pairs.
 * Used by Reading Copilot to extract 6-dimension analysis sections.
 */
describe("parseSections", () => {
  it("parses a single section", () => {
    const input = "## Translation\nThis is the translation.";
    expect(parseSections(input)).toEqual({
      Translation: "This is the translation.",
    });
  });

  it("parses multiple sections", () => {
    const input = `## Translation
This is translated text.
## Key Vocabulary
word1, word2, word3
## Summary
A brief summary.`;
    const result = parseSections(input);
    expect(result).toEqual({
      Translation: "This is translated text.",
      "Key Vocabulary": "word1, word2, word3",
      Summary: "A brief summary.",
    });
  });

  it("ignores text before the first ## header", () => {
    const input = `Some preamble text.
## First Section
Content here.`;
    const result = parseSections(input);
    expect(result).toEqual({
      "First Section": "Content here.",
    });
  });

  it("ignores sections with empty content", () => {
    const input = `## Empty
## Not Empty
Has content.`;
    const result = parseSections(input);
    expect(result).toEqual({
      "Not Empty": "Has content.",
    });
  });

  it("handles sections with multiline content", () => {
    const input = `## Analysis
Line one.
Line two.
Line three.`;
    const result = parseSections(input);
    expect(result.Analysis).toBe("Line one.\nLine two.\nLine three.");
  });

  it("returns empty object for text with no ## headers", () => {
    expect(parseSections("Just plain text without headers.")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseSections("")).toEqual({});
  });

  it("handles headers with tabs as separator", () => {
    const input = "## Title\t\nContent after tab.";
    const result = parseSections(input);
    expect(result.Title).toBe("Content after tab.");
  });

  it("handles sections with ## in content (not at line start)", () => {
    const input = `## Header
Content with ## inside it.`;
    const result = parseSections(input);
    expect(result.Header).toBe("Content with ## inside it.");
  });

  it("ignores a section that has only whitespace content", () => {
    const input = `## Empty Section

## Real Section
Actual content.`;
    const result = parseSections(input);
    expect(result).toEqual({
      "Real Section": "Actual content.",
    });
  });
});
