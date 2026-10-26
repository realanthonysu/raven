import { describe, expect, it } from "vitest";
import { exerciseScorePercent, listeningScorePercent } from "./score-percent";

// listeningScorePercent 的用例自 analytics.test.ts 随函数迁移（归一化归位
// lib/score-percent 后，图表模块不再承载域计算）。
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

describe("exerciseScorePercent", () => {
  it("converts correct-answer count to percent", () => {
    expect(exerciseScorePercent(8, 10)).toBe(80);
  });

  it("returns 0 when nothing is correct", () => {
    expect(exerciseScorePercent(0, 5)).toBe(0);
  });

  it("keeps fractional percents without rounding", () => {
    expect(exerciseScorePercent(1, 3)).toBeCloseTo(33.3333, 4);
  });

  it("returns null when there are no questions (no valid score, 除零语义与既有内联一致)", () => {
    expect(exerciseScorePercent(0, 0)).toBeNull();
  });
});
