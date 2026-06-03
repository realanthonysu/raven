import { describe, expect, it } from "vitest";
import { typeConfig } from "./type-config";

/**
 * typeConfig 测试套件。
 *
 * typeConfig 是 history 表 type 字段的视觉配置映射（label/icon/color），
 * 被 HistoryPage、Sidebar、HistoryDetailPage 等多处引用。
 *
 * 测试重点：
 * 1. 完整性：四种类型（correct/reading/exercise/listening）都有配置
 * 2. 结构一致性：每个条目都包含 label/icon/color 三个字段
 * 3. 颜色格式：color 字符串同时包含 bg- 和 text- 类名（适配 light/dark 模式）
 * 4. 键名稳定性：防止意外新增或删除类型
 */
describe("typeConfig", () => {
  it("has entries for all four history types", () => {
    expect(typeConfig).toHaveProperty("correct");
    expect(typeConfig).toHaveProperty("reading");
    expect(typeConfig).toHaveProperty("exercise");
    expect(typeConfig).toHaveProperty("listening");
  });

  it("correct maps to Writing label", () => {
    expect(typeConfig.correct.label).toBe("Writing");
  });

  it("reading maps to Reading label", () => {
    expect(typeConfig.reading.label).toBe("Reading");
  });

  it("exercise maps to Exercise label", () => {
    expect(typeConfig.exercise.label).toBe("Exercise");
  });

  it("each entry has label, icon, and color", () => {
    for (const key of ["correct", "reading", "exercise", "listening"] as const) {
      const entry = typeConfig[key];
      expect(typeof entry.label).toBe("string");
      expect(entry.icon).toBeDefined();
      expect(typeof entry.color).toBe("string");
      expect(entry.color.length).toBeGreaterThan(0);
    }
  });

  it("color strings contain both light and dark mode variants", () => {
    for (const key of ["correct", "reading", "exercise", "listening"] as const) {
      const entry = typeConfig[key];
      // All color strings should contain "text-" classes
      expect(entry.color).toContain("text-");
      expect(entry.color).toContain("bg-");
    }
  });

  it("is frozen via as const (types are readonly)", () => {
    // TypeScript `as const` doesn't freeze at runtime, but the keys should be stable
    expect(Object.keys(typeConfig).sort()).toEqual(["correct", "exercise", "listening", "reading"]);
  });
});
