/**
 * practice-options tests —— 练习难度展示格式化。
 *
 * formatDifficultyLabel 是持久化 difficulty 字符串的统一渲染入口：
 * 新数据（CEFR 级别码）渲染为「码（≈考试锚点）」双标注，旧数据
 * （初级/中级/高级 等非级别码字符串）原样直通，存量记录展示不变。
 */
import { describe, expect, it } from "vitest";
import { formatDifficultyLabel } from "./practice-options";

describe("formatDifficultyLabel", () => {
  it("旧值（初级/中级/高级）原样返回", () => {
    expect(formatDifficultyLabel("初级")).toBe("初级");
    expect(formatDifficultyLabel("中级")).toBe("中级");
    expect(formatDifficultyLabel("高级")).toBe("高级");
  });

  it("合法级别码渲染为「码（≈考试锚点）」双标注", () => {
    expect(formatDifficultyLabel("B2")).toBe("B2（≈大学六级 CET-6）");
  });

  it("六档之外的字符串原样返回（非法码不炸）", () => {
    expect(formatDifficultyLabel("Z9")).toBe("Z9");
  });
});
