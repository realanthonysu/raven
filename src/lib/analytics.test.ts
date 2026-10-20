import { describe, expect, it } from "vitest";
import {
  CATEGORY_COLORS,
  DIMENSION_CONFIG,
  DIMENSION_MAP,
  listeningScorePercent,
  PIE_COLORS,
  parseResult,
} from "./analytics";

describe("CATEGORY_COLORS", () => {
  it("maps all 11 error categories to valid hex colors", () => {
    const categories = Object.keys(CATEGORY_COLORS);
    expect(categories).toHaveLength(11);
    for (const color of Object.values(CATEGORY_COLORS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("includes common categories", () => {
    expect(CATEGORY_COLORS).toHaveProperty("时态错误");
    expect(CATEGORY_COLORS).toHaveProperty("拼写错误");
    expect(CATEGORY_COLORS).toHaveProperty("主谓一致");
  });
});

describe("PIE_COLORS", () => {
  it("contains 11 colors", () => {
    expect(PIE_COLORS).toHaveLength(11);
  });
});

describe("DIMENSION_MAP", () => {
  it("maps error categories to 4 capability dimensions", () => {
    const dimensions = new Set(Object.values(DIMENSION_MAP));
    expect(dimensions).toEqual(new Set(["语法", "词汇", "句式", "细节"]));
  });

  it("covers all 11 error categories", () => {
    expect(Object.keys(DIMENSION_MAP)).toHaveLength(11);
  });
});

describe("DIMENSION_CONFIG", () => {
  it("contains6 dimensions with name and color", () => {
    expect(DIMENSION_CONFIG).toHaveLength(6);
    for (const d of DIMENSION_CONFIG) {
      expect(d.name).toBeTruthy();
      expect(d.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// 注：isExerciseResult / isListeningResult / isCorrectionResult / isSpeakingResult
// 四个手写守卫已删除 —— 统一走 extractJsonSafe + Zod schema（schemas.test.ts
// 覆盖 schema 校验细节，下方 parseResult 覆盖"解析+校验"组合路径）。

describe("parseResult", () => {
  it("parses valid JSON correction result", () => {
    const json = JSON.stringify({
      corrected_text: "She goes.",
      corrections: [{ original: "go", corrected: "goes", category: "SVA", explanation: "SVA" }],
      summary: "Fix SVA",
    });
    const result = parseResult(json);
    expect(result).not.toBeNull();
    expect(result?.corrected_text).toBe("She goes.");
  });

  it("returns null for invalid JSON", () => {
    expect(parseResult("not json")).toBeNull();
  });

  it("returns null for JSON that doesn't match schema", () => {
    expect(parseResult('{"foo": "bar"}')).toBeNull();
  });
});

describe("listeningScorePercent", () => {
  it("converts correct-sentence count to percent", () => {
    expect(listeningScorePercent(4, 5)).toBe(80);
  });

  it("returns 0 when nothing is correct", () => {
    expect(listeningScorePercent(0, 5)).toBe(0);
  });

  it("keeps half points (close answers count 0.5)", () => {
    expect(listeningScorePercent(4.5, 5)).toBe(90);
  });

  it("returns null when there are no sentences (no valid score)", () => {
    expect(listeningScorePercent(0, 0)).toBeNull();
  });
});
