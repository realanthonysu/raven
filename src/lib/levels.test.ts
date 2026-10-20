import { describe, expect, it } from "vitest";
import {
  isLevelCode,
  LEVEL_CODE_ENUM_TEXT,
  LEVEL_CODES,
  LEVEL_SPECS,
  LEVEL_SURVEY_OPTIONS,
  levelLabel,
  levelPromptBlock,
  practiceLevelOptions,
} from "./levels";

describe("isLevelCode", () => {
  it("接受全部合法级别码", () => {
    for (const code of LEVEL_CODES) {
      expect(isLevelCode(code)).toBe(true);
    }
  });

  it("拒绝非法值", () => {
    expect(isLevelCode("A1")).toBe(false);
    expect(isLevelCode("b2")).toBe(false);
    expect(isLevelCode(null)).toBe(false);
    expect(isLevelCode(undefined)).toBe(false);
  });
});

describe("LEVEL_SPECS 完备性", () => {
  it("每个级别码都有规格且 code 自洽", () => {
    for (const code of LEVEL_CODES) {
      expect(LEVEL_SPECS[code].code).toBe(code);
      expect(LEVEL_SPECS[code].anchor).toBeTruthy();
      expect(LEVEL_SPECS[code].vocabBand).toBeTruthy();
    }
  });
});

describe("LEVEL_CODE_ENUM_TEXT", () => {
  it("包含全部合法级别码且不含尺子之外的档位", () => {
    for (const code of LEVEL_CODES) {
      expect(LEVEL_CODE_ENUM_TEXT).toContain(`"${code}"`);
    }
    expect(LEVEL_CODE_ENUM_TEXT).not.toContain("C2");
  });
});

describe("levelLabel", () => {
  it("生成含 CEFR 码与考试锚点的双标注", () => {
    expect(levelLabel("B1+")).toContain("B1+");
    expect(levelLabel("B1+")).toContain("四级");
  });
});

describe("LEVEL_SURVEY_OPTIONS", () => {
  it("全部选项映射到合法级别码", () => {
    for (const opt of LEVEL_SURVEY_OPTIONS) {
      expect(isLevelCode(opt.code)).toBe(true);
      expect(opt.label).toBeTruthy();
    }
  });
});

describe("practiceLevelOptions", () => {
  it("中间级别派生 低一档/标准/挑战 三项且从低到高", () => {
    const opts = practiceLevelOptions("B2");
    expect(opts.map((o) => o.code)).toEqual(["B1+", "B2", "B2+"]);
    expect(opts.map((o) => o.hint)).toEqual(["低一档", "标准", "挑战"]);
  });

  it("低端收缩为 2 项（A2 无低一档）", () => {
    const opts = practiceLevelOptions("A2");
    expect(opts.map((o) => o.code)).toEqual(["A2", "B1"]);
    expect(opts.map((o) => o.hint)).toEqual(["标准", "挑战"]);
  });

  it("高端收缩为 2 项（C1 无挑战档）", () => {
    const opts = practiceLevelOptions("C1");
    expect(opts.map((o) => o.code)).toEqual(["B2+", "C1"]);
    expect(opts.map((o) => o.hint)).toEqual(["低一档", "标准"]);
  });
});

describe("levelPromptBlock", () => {
  it("包含 CEFR 码、词汇范围与句子规格", () => {
    const block = levelPromptBlock("B2", "listening");
    expect(block).toContain("【难度规格 · CEFR B2");
    expect(block).toContain(LEVEL_SPECS.B2.vocabBand);
    expect(block).toContain(LEVEL_SPECS.B2.sentenceWords);
  });

  it("不同技能注入对应的附加指令", () => {
    expect(levelPromptBlock("B1", "writing")).toContain("纠错与建议以此级别为基准");
    expect(levelPromptBlock("B1", "reading")).toContain("讲解深度适配该级别读者");
    expect(levelPromptBlock("B1", "exercise")).toContain("严格按该级别标准命制");
  });
});
