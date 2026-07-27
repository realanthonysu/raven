import { describe, expect, it } from "vitest";
import {
  CATEGORY_COLORS,
  DIMENSION_CONFIG,
  DIMENSION_MAP,
  isCorrectionResult,
  isExerciseResult,
  isListeningResult,
  isSpeakingResult,
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

describe("type guards", () => {
  describe("isExerciseResult", () => {
    it("returns true for valid ExerciseResult", () => {
      const data = {
        category: "时态错误",
        exercises: [
          {
            type: "fill",
            question: "She ___ (go)",
            options: ["go", "goes"],
            answer: "goes",
            explanation: "SVA",
          },
        ],
        userAnswers: ["goes"],
        score: 100,
      };
      expect(isExerciseResult(data)).toBe(true);
    });

    it("returns false for invalid data", () => {
      expect(isExerciseResult(null)).toBe(false);
      expect(isExerciseResult({})).toBe(false);
      expect(isExerciseResult("string")).toBe(false);
    });
  });

  describe("isListeningResult", () => {
    it("returns true for valid ListeningResult", () => {
      const data = {
        difficulty: "初级",
        topic: "日常",
        sentences: [{ text: "Hello", hint: "你好" }],
        userInputs: ["Hello"],
        score: 1,
      };
      expect(isListeningResult(data)).toBe(true);
    });

    it("returns false for invalid data", () => {
      expect(isListeningResult(null)).toBe(false);
      expect(isListeningResult({ sentences: "not-array" })).toBe(false);
    });
  });

  describe("isCorrectionResult", () => {
    it("returns true for valid CorrectionResult", () => {
      const data = {
        corrected_text: "She goes.",
        corrections: [{ original: "go", corrected: "goes", category: "SVA", explanation: "SVA" }],
        summary: "Fix SVA",
      };
      expect(isCorrectionResult(data)).toBe(true);
    });

    it("returns false for invalid data", () => {
      expect(isCorrectionResult(null)).toBe(false);
      expect(isCorrectionResult({ corrected_text: 123 })).toBe(false);
    });
  });

  describe("isSpeakingResult", () => {
    it("returns true for valid SpeakingResult", () => {
      const data = {
        difficulty: "初级",
        topic: "日常",
        sentences: [{ text: "Hello", translation: "你好" }],
        results: [
          {
            sentence: { text: "Hello", translation: "你好" },
            transcription: "Hello",
            score: { pronunciation: 80, grammar: 90, fluency: 85, overall: 85, feedback: "Good" },
            skipped: false,
          },
        ],
        averageScore: 85,
      };
      expect(isSpeakingResult(data)).toBe(true);
    });

    it("returns false for invalid data", () => {
      expect(isSpeakingResult(null)).toBe(false);
    });
  });
});

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
