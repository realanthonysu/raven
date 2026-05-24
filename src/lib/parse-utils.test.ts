import { describe, it, expect } from "vitest";
import { parseCorrectionJson } from "./parse-utils";

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
});
