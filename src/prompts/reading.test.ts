import { describe, expect, it } from "vitest";
import { LEVEL_SPECS, levelPromptBlock } from "@/lib/levels";
import { READING_SECTION_KEY } from "@/lib/type-config";
import { buildReadingPrompt } from "./reading";

describe("buildReadingPrompt", () => {
  it("keeps all six ## section headers (READING_SECTION_KEY)", () => {
    const prompt = buildReadingPrompt("B1");
    for (const key of Object.values(READING_SECTION_KEY)) {
      expect(prompt).toContain(`## ${key}`);
    }
  });

  it("keeps the six-dimension instructions intact", () => {
    const prompt = buildReadingPrompt("B1");
    expect(prompt).toContain("给出文章的完整中文翻译");
    expect(prompt).toContain("根据文章长度，选取 5-8 个重点词汇进行分析");
    expect(prompt).toContain("根据文章长度，选取结构复杂的长难句进行拆解分析");
    expect(prompt).toContain("在原文中选取若干语法点进行分析");
    expect(prompt).toContain("翻译技巧");
    expect(prompt).toContain("2-3个开放性思考问题");
  });

  it("leads with the reader level line (CEFR code + exam anchor)", () => {
    const prompt = buildReadingPrompt("B1+");
    expect(prompt).toContain("读者水平：CEFR B1+（≈大学四级 CET-4）");
  });

  it("appends the level difficulty spec block (reading skill)", () => {
    const prompt = buildReadingPrompt("B2");
    expect(prompt).toContain(levelPromptBlock("B2", "reading"));
    // 规格块位于提示词末尾
    expect(prompt.endsWith(levelPromptBlock("B2", "reading"))).toBe(true);
  });

  it("produces different specs for different levels", () => {
    const a2 = buildReadingPrompt("A2");
    const c1 = buildReadingPrompt("C1");
    expect(a2).not.toBe(c1);
    expect(a2).toContain(LEVEL_SPECS.A2.vocabBand);
    expect(a2).not.toContain(LEVEL_SPECS.C1.vocabBand);
    expect(c1).toContain(LEVEL_SPECS.C1.vocabBand);
    expect(c1).toContain("读者水平：CEFR C1（≈专业八级 TEM-8 / 雅思 7+）");
  });

  it("every level yields a well-formed prompt", () => {
    for (const spec of Object.values(LEVEL_SPECS)) {
      const prompt = buildReadingPrompt(spec.code);
      expect(prompt).toContain(`读者水平：CEFR ${spec.code}（≈${spec.anchor}）`);
      expect(prompt).toContain(levelPromptBlock(spec.code, "reading"));
    }
  });
});
