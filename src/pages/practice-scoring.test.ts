/**
 * practice-scoring 纯函数测试。
 *
 * 用例输入按 matchAnswerDetail 的真实判定行为构造：
 * - correct：归一化（小写/去标点/并空白）后完全一致
 * - close：词级差异恰为 1（单词内容不同或词数差 1）
 * - wrong：词级差异 ≥ 2（含空输入——normalize 后为空串，与多词原句差异远超 1）
 */
import { describe, expect, it } from "vitest";
import { scoreDictation } from "./practice-scoring";

describe("scoreDictation", () => {
  it("scores an exact match as 1 point", () => {
    const score = scoreDictation(
      ["The quick brown fox jumps"],
      [{ text: "The quick brown fox jumps" }],
    );
    expect(score).toBe(1);
  });

  it("ignores case and punctuation via the rewrite matcher", () => {
    const score = scoreDictation(
      ["the QUICK brown fox jumps!"],
      [{ text: "The quick brown fox jumps" }],
    );
    expect(score).toBe(1);
  });

  it("scores a one-word-difference answer as 0.5 (close)", () => {
    const score = scoreDictation(
      ["The quick brown fox jump"],
      [{ text: "The quick brown fox jumps" }],
    );
    expect(score).toBe(0.5);
  });

  it("scores a clearly different answer as 0 (wrong)", () => {
    const score = scoreDictation(
      ["Completely different words here"],
      [{ text: "The quick brown fox jumps" }],
    );
    expect(score).toBe(0);
  });

  it("scores an empty input as 0 (wrong, not close)", () => {
    const score = scoreDictation([""], [{ text: "The quick brown fox jumps" }]);
    expect(score).toBe(0);
  });

  it("accumulates mixed results across sentences (correct + close + wrong)", () => {
    const score = scoreDictation(
      [
        "She sells seashells",
        "The weather is beautful", // 词级差异 1 → close
        "no idea at all really",
        "", // 未作答 → wrong
      ],
      [
        { text: "She sells seashells" },
        { text: "The weather is beautiful" },
        { text: "How are you doing today" },
        { text: "I love learning English" },
      ],
    );
    expect(score).toBe(1.5);
  });
});
