/**
 * PLACEMENT_PROMPT 测试套件（Track A：AI 定级测试）。
 *
 * 覆盖题量/档位结构（12 题 = 6 档 × 2）、难度递增、题型混合、
 * 「4 选项 + answer 与选项一致 + band 六值之一」硬性要求、JSON 信封结构，
 * 以及各档难度规格由 LEVEL_SPECS 单一事实来源注入。
 */

import { describe, expect, it } from "vitest";
import { LEVEL_CODE_ENUM_TEXT, LEVEL_CODES, LEVEL_SPECS } from "@/lib/levels";
import { PLACEMENT_PROMPT } from "./placement";

describe("PLACEMENT_PROMPT", () => {
  it("requests 12 questions across 6 bands, 2 per band", () => {
    expect(PLACEMENT_PROMPT).toContain("12 道");
    expect(PLACEMENT_PROMPT).toContain("6 个级别档");
    expect(PLACEMENT_PROMPT).toContain("每档 2 题");
  });

  it("requires strictly increasing difficulty across bands", () => {
    expect(PLACEMENT_PROMPT).toContain("难度随档位严格递增");
  });

  it("mixes vocabulary / grammar / context question types", () => {
    expect(PLACEMENT_PROMPT).toContain("词汇选择");
    expect(PLACEMENT_PROMPT).toContain("语法填空");
    expect(PLACEMENT_PROMPT).toContain("语境填空");
  });

  it("requires exactly 4 options with a single correct answer", () => {
    expect(PLACEMENT_PROMPT).toContain("恰好 4 个选项");
    expect(PLACEMENT_PROMPT).toContain("只有 1 个正确");
  });

  it("requires the answer to match an option verbatim", () => {
    expect(PLACEMENT_PROMPT).toContain("answer 必须是 4 个选项中的某一项的原文");
    expect(PLACEMENT_PROMPT).toContain("完全一致");
  });

  it("restricts band to the six CEFR codes", () => {
    expect(PLACEMENT_PROMPT).toContain(`${LEVEL_CODES.length} 个值之一`);
    for (const code of LEVEL_CODES) {
      expect(PLACEMENT_PROMPT).toContain(`"${code}"`);
    }
    // 枚举清单由 LEVEL_CODE_ENUM_TEXT 派生（单一事实来源）
    expect(PLACEMENT_PROMPT).toContain(LEVEL_CODE_ENUM_TEXT);
    // 尺子之外的档位（已退役/越界）不得出现在 prompt 中
    expect(PLACEMENT_PROMPT).not.toContain("C2");
  });

  it("requires self-contained questions", () => {
    expect(PLACEMENT_PROMPT).toContain("每题自包含");
    expect(PLACEMENT_PROMPT).toContain("不依赖其他题目或上下文");
  });

  it("requests the JSON envelope with question/options/answer/band/focus", () => {
    expect(PLACEMENT_PROMPT).toContain('"questions"');
    expect(PLACEMENT_PROMPT).toContain('"question"');
    expect(PLACEMENT_PROMPT).toContain('"options"');
    expect(PLACEMENT_PROMPT).toContain('"answer"');
    expect(PLACEMENT_PROMPT).toContain('"band"');
    expect(PLACEMENT_PROMPT).toContain('"focus"');
    // 严格 JSON：禁止代码块包裹与额外解释
    expect(PLACEMENT_PROMPT).toContain("不要用 markdown 代码块包裹");
    expect(PLACEMENT_PROMPT).toContain("不要输出任何其他内容");
  });

  it("injects per-band specs from LEVEL_SPECS (single source of truth)", () => {
    // 每档的词汇范围原文出现在 prompt 中，且级别尺子之外的档不会出现
    for (const code of LEVEL_CODES) {
      expect(PLACEMENT_PROMPT).toContain(LEVEL_SPECS[code].vocabBand);
    }
    expect(PLACEMENT_PROMPT).toContain("中考核心词汇（约 1600 词）以内");
    expect(PLACEMENT_PROMPT).toContain("专业八级及以上词汇（约 13000 词）");
  });

  it("keeps each band's grammar scope within that band's spec", () => {
    // B2 档的语法规格出现，且 C1 的学术语域规格不会错位到 B2 行
    expect(PLACEMENT_PROMPT).toContain("虚拟语气、倒装、独立主格、名词性从句嵌套");
    expect(PLACEMENT_PROMPT).toContain("任意复杂语法结构，学术与正式语域");
  });
});
