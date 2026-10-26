import { describe, expect, it } from "vitest";
import {
  applyMasteryWeight,
  collectWrongQuestions,
  computeCategoryMastery,
  countCorrectionCategories,
  type ExerciseAttempt,
  MASTERY_WEIGHT_FACTOR,
  type ParsedExerciseEntry,
  parseExerciseAttempts,
} from "./exercise-stats";

// ============================================================================
// Helpers
// ============================================================================

function attempt(category: string, score: number, total: number, day: number): ExerciseAttempt {
  return {
    category,
    score,
    total,
    createdAt: `2026-07-${String(day).padStart(2, "0")} 10:00:00`,
  };
}

function parsedEntry(
  id: number,
  category: string,
  answers: { answer: string; userAnswer: string }[],
  day: number = 1,
): ParsedExerciseEntry {
  return {
    record: { id, created_at: `2026-07-${String(day).padStart(2, "0")} 10:00:00` },
    result: {
      category,
      exercises: answers.map((a, i) => ({
        type: "fill" as const,
        question: `Q${i}`,
        answer: a.answer,
        explanation: "",
      })),
      userAnswers: answers.map((a) => a.userAnswer),
      score: answers.filter((a) => a.answer === a.userAnswer).length,
    },
  };
}

// ============================================================================
// computeCategoryMastery
// ============================================================================

describe("computeCategoryMastery", () => {
  it("returns empty map for no attempts", () => {
    expect(computeCategoryMastery([]).size).toBe(0);
  });

  it("aggregates attempts and accuracy per category", () => {
    const mastery = computeCategoryMastery([
      attempt("时态错误", 3, 5, 1),
      attempt("时态错误", 5, 5, 2),
      attempt("介词误用", 2, 5, 1),
    ]);
    const tense = mastery.get("时态错误");
    expect(tense?.attempts).toBe(2);
    expect(tense?.accuracy).toBe(80); // (3+5)/10
    const prep = mastery.get("介词误用");
    expect(prep?.attempts).toBe(1);
    expect(prep?.accuracy).toBe(40);
  });

  it("marks category mastered when attempts and recent accuracy meet thresholds", () => {
    const mastery = computeCategoryMastery([
      attempt("时态错误", 4, 5, 1),
      attempt("时态错误", 5, 5, 2),
    ]);
    expect(mastery.get("时态错误")?.mastered).toBe(true);
  });

  it("does not mark mastered with only one attempt even if perfect", () => {
    const mastery = computeCategoryMastery([attempt("时态错误", 5, 5, 1)]);
    expect(mastery.get("时态错误")?.mastered).toBe(false);
  });

  it("does not mark mastered when recent accuracy is below threshold", () => {
    const mastery = computeCategoryMastery([
      attempt("时态错误", 5, 5, 1),
      attempt("时态错误", 2, 5, 2),
      attempt("时态错误", 3, 5, 3),
    ]);
    expect(mastery.get("时态错误")?.mastered).toBe(false);
  });

  it("uses only the recent window for recentAccuracy (old poor scores ignored)", () => {
    // 早期成绩差，但最近 3 次全对 → recentAccuracy 100，应判定掌握
    const mastery = computeCategoryMastery([
      attempt("时态错误", 0, 5, 1),
      attempt("时态错误", 0, 5, 2),
      attempt("时态错误", 5, 5, 3),
      attempt("时态错误", 5, 5, 4),
      attempt("时态错误", 5, 5, 5),
    ]);
    const m = mastery.get("时态错误");
    expect(m?.recentAccuracy).toBe(100);
    expect(m?.mastered).toBe(true);
    expect(m?.accuracy).toBe(60); // 15/25
  });

  it("skips attempts with empty category or zero total", () => {
    const mastery = computeCategoryMastery([attempt("", 5, 5, 1), attempt("时态错误", 0, 0, 1)]);
    expect(mastery.size).toBe(0);
  });
});

// ============================================================================
// applyMasteryWeight
// ============================================================================

describe("applyMasteryWeight", () => {
  it("halves weight for mastered categories and re-sorts", () => {
    const mastery = computeCategoryMastery([
      attempt("时态错误", 5, 5, 1),
      attempt("时态错误", 5, 5, 2),
    ]);
    const weighted = applyMasteryWeight(
      [
        { name: "时态错误", count: 10 },
        { name: "介词误用", count: 6 },
      ],
      mastery,
    );
    // 时态错误已掌握：10 * 0.5 = 5 < 6，介词误用应排第一
    expect(weighted[0].name).toBe("介词误用");
    expect(weighted[0].weight).toBe(6);
    expect(weighted[1].name).toBe("时态错误");
    expect(weighted[1].weight).toBe(10 * MASTERY_WEIGHT_FACTOR);
    expect(weighted[1].mastery?.mastered).toBe(true);
  });

  it("keeps original weight for unmastered or unknown categories", () => {
    const weighted = applyMasteryWeight([{ name: "介词误用", count: 4 }], new Map());
    expect(weighted[0].weight).toBe(4);
    expect(weighted[0].mastery).toBeNull();
  });
});

// ============================================================================
// collectWrongQuestions
// ============================================================================

describe("collectWrongQuestions", () => {
  it("collects only wrong answers with source info", () => {
    const wrong = collectWrongQuestions([
      parsedEntry(1, "时态错误", [
        { answer: "went", userAnswer: "went" },
        { answer: "gone", userAnswer: "goed" },
      ]),
    ]);
    expect(wrong).toHaveLength(1);
    expect(wrong[0].historyId).toBe(1);
    expect(wrong[0].category).toBe("时态错误");
    expect(wrong[0].question.answer).toBe("gone");
    expect(wrong[0].userAnswer).toBe("goed");
  });

  it("uses matchAnswer semantics (case-insensitive for fill)", () => {
    const wrong = collectWrongQuestions([
      parsedEntry(1, "时态错误", [{ answer: "went", userAnswer: "WENT" }]),
    ]);
    expect(wrong).toHaveLength(0);
  });

  it("orders newest records first and respects limit", () => {
    const wrong = collectWrongQuestions(
      [
        parsedEntry(1, "旧记录", [{ answer: "a", userAnswer: "x" }], 1),
        parsedEntry(
          2,
          "新记录",
          [
            { answer: "b", userAnswer: "y" },
            { answer: "c", userAnswer: "z" },
          ],
          5,
        ),
      ],
      2,
    );
    expect(wrong).toHaveLength(2);
    expect(wrong[0].category).toBe("新记录");
    expect(wrong[1].category).toBe("新记录");
  });

  it("treats missing user answers as wrong", () => {
    const entry = parsedEntry(1, "时态错误", [{ answer: "went", userAnswer: "" }]);
    entry.result.userAnswers = []; // 用户未作答
    const wrong = collectWrongQuestions([entry]);
    expect(wrong).toHaveLength(1);
    expect(wrong[0].userAnswer).toBe("");
  });
});

// ============================================================================
// countCorrectionCategories / parseExerciseAttempts / 掌握度按 createdAt 排序回归
// ============================================================================

describe("countCorrectionCategories", () => {
  it("counts categories and skips empty names", () => {
    const map = countCorrectionCategories([
      { category: "时态错误" },
      { category: "时态错误" },
      { category: "单复数" },
      { category: "" },
    ]);
    expect(map.get("时态错误")).toBe(2);
    expect(map.get("单复数")).toBe(1);
    expect(map.size).toBe(2);
  });

  it("returns empty map for empty input", () => {
    expect(countCorrectionCategories([]).size).toBe(0);
  });
});

describe("parseExerciseAttempts", () => {
  it("parses valid results and skips structurally invalid ones", () => {
    const good = JSON.stringify({
      category: "时态错误",
      exercises: [{ type: "fill", question: "Q", answer: "a", explanation: "" }],
      userAnswers: ["a"],
      score: 1,
    });
    const attempts = parseExerciseAttempts([
      { result: good, createdAt: "2026-07-01 10:00:00" },
      { result: "not json", createdAt: "2026-07-02 10:00:00" },
      { result: "", createdAt: "2026-07-03 10:00:00" }, // result 缺失（fail-soft 空配对）
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({
      category: "时态错误",
      score: 1,
      total: 1,
      createdAt: "2026-07-01 10:00:00",
    });
  });
});

describe("computeCategoryMastery recency derives from createdAt, not input order", () => {
  // 回归：此前存在"缺省 createdAt 时按输入序认定最新在前"的隐式约定，
  // 调用方（Dashboard）依赖 getHistoryResultsByType 的 DESC 返回顺序才不出错。
  // 现在 createdAt 必填、窗口完全由时间戳排序推导——打乱输入顺序结果必须一致。
  const newest = { category: "时态错误", score: 2, total: 2, createdAt: "2026-07-04 10:00:00" };
  const middle1 = { category: "时态错误", score: 2, total: 2, createdAt: "2026-07-03 10:00:00" };
  const middle2 = { category: "时态错误", score: 2, total: 2, createdAt: "2026-07-02 10:00:00" };
  const oldest = { category: "时态错误", score: 0, total: 2, createdAt: "2026-07-01 10:00:00" };

  it("picks the recent window by timestamp regardless of input order", () => {
    for (const attempts of [
      [oldest, middle1, middle2, newest],
      [newest, oldest, middle2, middle1],
      [middle2, newest, oldest, middle1],
    ]) {
      const m = computeCategoryMastery(attempts).get("时态错误");
      expect(m).toBeDefined();
      // 最近窗口（时间戳最新的 3 次）全对 → recentAccuracy=100
      expect(m?.recentAccuracy).toBe(100);
      // 总 accuracy 受最早那次拖累：(2+2+2+0)/(2*4)=75
      expect(m?.accuracy).toBe(75);
      expect(m?.mastered).toBe(true);
    }
  });

  it("uses the oldest-in-window entry when timestamps decide (not array position)", () => {
    // 最新一次为 0 分：无论它出现在输入的哪个位置，都应落入最近窗口拖低正确率
    for (const attempts of [
      [{ ...newest, score: 0 }, middle1, middle2, { ...oldest, score: 2 }],
      [middle1, { ...newest, score: 0 }, { ...oldest, score: 2 }, middle2],
    ]) {
      const m = computeCategoryMastery(attempts).get("时态错误");
      // 最近窗口 = [middle2(2/2), middle1(2/2), newest(0/2)] → 4/6 ≈ 67
      expect(m?.recentAccuracy).toBe(67);
      expect(m?.mastered).toBe(false);
    }
  });
});
