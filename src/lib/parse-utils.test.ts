import { describe, it, expect } from "vitest";
import { parseCorrectionJson, matchAnswer } from "./parse-utils";

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
    const input = "```json\n" + json + "\n```";
    expect(parseCorrectionJson(input)?.corrected_text).toBe("Fixed text");
  });

  it("parses JSON inside markdown code block without language tag", () => {
    const json = JSON.stringify({
      corrected_text: "No lang tag",
      corrections: [],
      summary: "ok",
    });
    const input = "```\n" + json + "\n```";
    expect(parseCorrectionJson(input)?.corrected_text).toBe("No lang tag");
  });

  it("parses JSON surrounded by extra text", () => {
    const json = '{"corrected_text":"Hi","corrections":[],"summary":"ok"}';
    const input = "Here is the result:\n" + json + "\nDone.";
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
    expect(result!.corrections).toHaveLength(1);
    expect(result!.corrections[0].category).toBe("语法");
  });

  it("parses JSON wrapped in code block with surrounding text", () => {
    const json = JSON.stringify({
      corrected_text: "Done",
      corrections: [],
      summary: "ok",
    });
    const input = "Here is the correction:\n```json\n" + json + "\n```\nHope this helps!";
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
    expect(result!.corrected_text).toBe("Use {brackets} carefully.");
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
