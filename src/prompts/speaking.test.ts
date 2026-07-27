import { describe, expect, it } from "vitest";
import { EVALUATION_PROMPT, SPEAKING_PROMPT } from "./speaking";

describe("SPEAKING_PROMPT", () => {
  it("includes difficulty and topic parameters", () => {
    const prompt = SPEAKING_PROMPT("中级", "科技");
    expect(prompt).toContain("中级");
    expect(prompt).toContain("科技");
  });

  it("requests JSON output format", () => {
    const prompt = SPEAKING_PROMPT("初级", "日常");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain('"sentences"');
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"translation"');
  });

  it("specifies 5 sentences", () => {
    const prompt = SPEAKING_PROMPT("高级", "商务");
    expect(prompt).toContain("5");
  });

  it("mentions difficulty progression", () => {
    const prompt = SPEAKING_PROMPT("初级", "日常");
    expect(prompt).toContain("递进");
  });
});

describe("EVALUATION_PROMPT", () => {
  it("includes original and transcription text", () => {
    const prompt = EVALUATION_PROMPT("Hello world", "helo world");
    expect(prompt).toContain("Hello world");
    expect(prompt).toContain("helo world");
  });

  it("requests pronunciation, grammar, fluency scores", () => {
    const prompt = EVALUATION_PROMPT("Test", "test");
    expect(prompt).toContain("pronunciation");
    expect(prompt).toContain("grammar");
    expect(prompt).toContain("fluency");
    expect(prompt).toContain("overall");
  });

  it("requests word alignment with IPA", () => {
    const prompt = EVALUATION_PROMPT("Test sentence", "test sentense");
    expect(prompt).toContain("wordAlignment");
    expect(prompt).toContain("ipa");
    expect(prompt).toContain("correct");
    expect(prompt).toContain("mispronounced");
    expect(prompt).toContain("missed");
  });

  it("wraps user text in user-input tags", () => {
    const prompt = EVALUATION_PROMPT("Original", "transcription");
    expect(prompt).toContain("<user-input>Original</user-input>");
    expect(prompt).toContain("<user-input>transcription</user-input>");
  });
});
