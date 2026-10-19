import { describe, expect, it } from "vitest";
import { LISTENING_PROMPT } from "./listening";

describe("LISTENING_PROMPT", () => {
  it("includes the level spec block and topic parameters", () => {
    const prompt = LISTENING_PROMPT("B2", "旅行");
    expect(prompt).toContain("【难度规格 · CEFR B2");
    expect(prompt).toContain("旅行");
  });

  it("wraps the topic in topic tags", () => {
    const prompt = LISTENING_PROMPT("B2", "旅行");
    expect(prompt).toContain("<topic>旅行</topic>");
  });

  it("no longer carries the legacy 初级/中级/高级 difficulty rules", () => {
    const prompt = LISTENING_PROMPT("B1", "日常");
    expect(prompt).not.toContain("初级");
    expect(prompt).not.toContain("中级");
    expect(prompt).not.toContain("高级");
  });

  it("requests JSON output with sentences array", () => {
    const prompt = LISTENING_PROMPT("A2", "日常");
    expect(prompt).toContain('"sentences"');
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"hint"');
  });

  it("specifies 5 sentences", () => {
    const prompt = LISTENING_PROMPT("C1", "科技");
    expect(prompt).toContain("5");
  });

  it("requests progressive difficulty via the level spec block", () => {
    const prompt = LISTENING_PROMPT("B1", "日常");
    expect(prompt).toContain("递进");
  });

  it("requests Chinese hints", () => {
    const prompt = LISTENING_PROMPT("B1", "日常");
    expect(prompt).toContain("中文");
    expect(prompt).toContain("hint");
  });
});
