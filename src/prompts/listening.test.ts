import { describe, expect, it } from "vitest";
import { LISTENING_PROMPT, VOCAB_EXTRACTION_PROMPT } from "./listening";

describe("LISTENING_PROMPT", () => {
  it("includes difficulty and topic parameters", () => {
    const prompt = LISTENING_PROMPT("中级", "旅行");
    expect(prompt).toContain("中级");
    expect(prompt).toContain("旅行");
  });

  it("requests JSON output with sentences array", () => {
    const prompt = LISTENING_PROMPT("初级", "日常");
    expect(prompt).toContain('"sentences"');
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"hint"');
  });

  it("includes difficulty rules for all levels", () => {
    const prompt = LISTENING_PROMPT("初级", "日常");
    expect(prompt).toContain("初级");
    expect(prompt).toContain("中级");
    expect(prompt).toContain("高级");
  });

  it("specifies 5 sentences", () => {
    const prompt = LISTENING_PROMPT("高级", "科技");
    expect(prompt).toContain("5");
  });

  it("requests progressive difficulty", () => {
    const prompt = LISTENING_PROMPT("初级", "日常");
    expect(prompt).toContain("递进");
  });

  it("requests Chinese hints", () => {
    const prompt = LISTENING_PROMPT("初级", "日常");
    expect(prompt).toContain("中文");
    expect(prompt).toContain("hint");
  });
});

describe("VOCAB_EXTRACTION_PROMPT", () => {
  it("includes the wrong sentences in user-input tags", () => {
    const prompt = VOCAB_EXTRACTION_PROMPT("The cat sit on the mat.");
    expect(prompt).toContain("The cat sit on the mat.");
    expect(prompt).toContain("<user-input>");
    expect(prompt).toContain("</user-input>");
  });

  it("requests JSON output with words array", () => {
    const prompt = VOCAB_EXTRACTION_PROMPT("test");
    expect(prompt).toContain('"words"');
    expect(prompt).toContain('"word"');
    expect(prompt).toContain('"meaning"');
  });

  it("requests3-5 vocabulary words", () => {
    const prompt = VOCAB_EXTRACTION_PROMPT("test");
    expect(prompt).toContain("3-5");
  });

  it("requests Chinese meanings", () => {
    const prompt = VOCAB_EXTRACTION_PROMPT("test");
    expect(prompt).toContain("中文释义");
  });
});
