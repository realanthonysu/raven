import { describe, expect, it } from "vitest";
import { ENRICHMENT_PROMPT } from "./enrichment";

describe("ENRICHMENT_PROMPT", () => {
  it("interpolates the target word", () => {
    const prompt = ENRICHMENT_PROMPT("serendipity");
    expect(prompt).toContain("单词：serendipity");
  });

  it("requests strict JSON output with all four EnrichedWord fields", () => {
    const prompt = ENRICHMENT_PROMPT("word");
    expect(prompt).toContain("JSON 格式");
    expect(prompt).toContain('"phonetic"');
    expect(prompt).toContain('"definition"');
    expect(prompt).toContain('"collocations"');
    expect(prompt).toContain('"example"');
  });

  it("requests the level field with the full 11-value exam-system enum", () => {
    const prompt = ENRICHMENT_PROMPT("word");
    expect(prompt).toContain('"level"');
    // 11 值枚举与 WordLevelSchema 一一对应，缺一即指令不完整
    for (const level of [
      "小学",
      "中考",
      "高考",
      "CET-4",
      "CET-6",
      "考研",
      "TEM-4",
      "TEM-8",
      "雅思",
      "托福",
      "超纲",
    ]) {
      expect(prompt).toContain(level);
    }
  });

  it("instructs exam-system attribution with cross-tier lowest-band rule", () => {
    const prompt = ENRICHMENT_PROMPT("word");
    // 判定依据与示例
    expect(prompt).toContain("中国英语考试体系词汇表");
    expect(prompt).toContain('"apple"→"小学"');
    expect(prompt).toContain('"negotiate"→"CET-4"');
    expect(prompt).toContain('"ubiquitous"→"考研"或"超纲"');
    // 跨档取最低归属档 + 超纲兜底
    expect(prompt).toContain("跨档词");
    expect(prompt).toContain("最低归属档");
    expect(prompt).toContain("超纲");
  });
});
