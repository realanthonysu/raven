/**
 * buildCorrectPrompt 测试套件（Track 3：CEFR 级别体系 · 写作切片）。
 *
 * 覆盖难度规格注入、level_estimate（写作水平估级）输出结构、
 * 六档 band 枚举指令、错误类别清单完整性，以及不同级别生成不同规格。
 */

import { describe, expect, it } from "vitest";
import { LEVEL_CODE_ENUM_TEXT, LEVEL_CODES } from "@/lib/levels";
import { buildCorrectPrompt } from "./correct";

/** 11 种错误类别标签（与 prompt 原文一致） */
const ERROR_CATEGORIES = [
  "主谓一致",
  "冠词错误",
  "单复数",
  "用词不当",
  "时态错误",
  "拼写错误",
  "介词错误",
  "句式杂糅",
  "标点错误",
  "缺少成分",
  "语序错误",
];

describe("buildCorrectPrompt", () => {
  it("注入对应级别的难度规格块", () => {
    const prompt = buildCorrectPrompt("B1+");
    // 规格块标题含级别码与考试锚点（levelPromptBlock 的输出格式）
    expect(prompt).toContain("【难度规格 · CEFR B1+，≈大学四级 CET-4】");
    expect(prompt).toContain("大学英语四级词汇（约 4500 词）以内");
  });

  it("包含写作维度的难度指令（纠错以该级别为基准）", () => {
    const prompt = buildCorrectPrompt("B2");
    expect(prompt).toContain("纠错与建议以此级别为基准");
  });

  it("要求输出 level_estimate 估级结构（band + rationale）", () => {
    const prompt = buildCorrectPrompt("B1");
    expect(prompt).toContain('"level_estimate"');
    expect(prompt).toContain('"band"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain("40字以内");
  });

  it("band 限定为六档 CEFR 枚举值之一", () => {
    const prompt = buildCorrectPrompt("B1");
    for (const code of LEVEL_CODES) {
      expect(prompt).toContain(`"${code}"`);
    }
    expect(prompt).toContain(`${LEVEL_CODES.length} 个值之一`);
    // 枚举清单由 LEVEL_CODE_ENUM_TEXT 派生（单一事实来源）
    expect(prompt).toContain(LEVEL_CODE_ENUM_TEXT);
    // 尺子之外的档位（已退役/越界）不得出现在 prompt 中
    expect(prompt).not.toContain("C2");
    // 估级依据：以难度规格为基准，结合词汇/语法/句式浮动评估
    expect(prompt).toContain("词汇丰富度、语法准确性、句式复杂度");
  });

  it("保留原有任务描述与 JSON 主结构", () => {
    const prompt = buildCorrectPrompt("A2");
    expect(prompt).toContain("你是一个专业的英语纠错助手");
    expect(prompt).toContain('"corrected_text"');
    expect(prompt).toContain('"corrections"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"original"');
    expect(prompt).toContain('"corrected"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"explanation"');
    expect(prompt).toContain("不要输出任何其他内容");
  });

  it("错误类别清单完整（11 种）", () => {
    const prompt = buildCorrectPrompt("B1");
    for (const category of ERROR_CATEGORIES) {
      expect(prompt).toContain(category);
    }
  });

  it("每个级别生成各自的难度规格", () => {
    for (const code of LEVEL_CODES) {
      const prompt = buildCorrectPrompt(code);
      expect(prompt).toContain(`【难度规格 · CEFR ${code}，`);
    }
  });

  it("不同级别生成不同的 prompt", () => {
    const a2 = buildCorrectPrompt("A2");
    const c1 = buildCorrectPrompt("C1");
    expect(a2).not.toBe(c1);
    expect(a2).toContain("中考核心词汇（约 1600 词）以内");
    expect(c1).toContain("专业八级及以上词汇（约 13000 词）");
    // A2 的规格不应出现在 C1 的 prompt 中
    expect(c1).not.toContain("中考核心词汇");
  });
});
