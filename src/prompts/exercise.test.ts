import { describe, expect, it } from "vitest";
import { LEVEL_SPECS, levelPromptBlock } from "@/lib/levels";
import { buildExercisePrompt } from "./exercise";

describe("buildExercisePrompt", () => {
  // ── 基础契约（不随级别变化） ──────────────────────────────

  it("includes the category and the mapped question type", () => {
    const prompt = buildExercisePrompt("时态错误");
    expect(prompt).toContain("时态错误");
    // 时态类 → 填空题
    expect(prompt).toContain("填空题（选择正确的词形或选项）");
  });

  it("requests strict JSON with an exercises array", () => {
    const prompt = buildExercisePrompt("冠词错误");
    expect(prompt).toContain('"exercises"');
    expect(prompt).toContain("不要用 markdown 代码块包裹");
  });

  it("honors the count parameter", () => {
    expect(buildExercisePrompt("单复数", undefined, 3)).toContain("请生成 3 道针对性练习题");
  });

  it("wraps user context in XML tags (prompt-injection guard)", () => {
    const prompt = buildExercisePrompt("用词不当", "近期错误：冠词");
    expect(prompt).toContain("<user-context>\n近期错误：冠词\n</user-context>");
  });

  // ── 无 level：向后兼容（旧行为） ──────────────────────────

  it("keeps legacy behavior when no level is given", () => {
    const prompt = buildExercisePrompt("主谓一致");
    expect(prompt).toContain("5 道题难度递进，从简单到中等");
    // 旧行为不注入任何难度规格
    expect(prompt).not.toContain("【难度规格");
    expect(prompt).not.toContain("上述难度规格");
  });

  it("legacy layout has no stray blank lines around the question type", () => {
    const prompt = buildExercisePrompt("主谓一致");
    expect(prompt).toContain("题型：填空题（选择正确的词形或选项）\n\n请严格按以下 JSON 格式输出");
  });

  // ── 有 level：注入难度规格 ──────────────────────────────

  it("injects the level spec block and rewrites the difficulty rule", () => {
    const prompt = buildExercisePrompt("主谓一致", undefined, 5, "B2");
    expect(prompt).toContain(levelPromptBlock("B2", "exercise"));
    expect(prompt).toContain("5 道题在上述难度规格内由易到难排列");
    // 旧文案不再出现
    expect(prompt).not.toContain("难度递进，从简单到中等");
  });

  it("places the spec block before the 要求 section so 上述 reads correctly", () => {
    const prompt = buildExercisePrompt("主谓一致", undefined, 5, "A2");
    const specIdx = prompt.indexOf("【难度规格");
    const ruleIdx = prompt.indexOf("在上述难度规格内由易到难排列");
    expect(specIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(specIdx);
  });

  it("keeps the level spec when user context is also present", () => {
    const prompt = buildExercisePrompt("句式杂糅", "ctx", 5, "C1");
    expect(prompt).toContain(levelPromptBlock("C1", "exercise"));
    expect(prompt).toContain("<user-context>\nctx\n</user-context>");
  });

  it("produces different specs for different levels", () => {
    const a2 = buildExercisePrompt("主谓一致", undefined, 5, "A2");
    const c1 = buildExercisePrompt("主谓一致", undefined, 5, "C1");
    expect(a2).not.toBe(c1);
    expect(a2).toContain(LEVEL_SPECS.A2.grammarFocus);
    expect(a2).not.toContain(LEVEL_SPECS.C1.grammarFocus);
    expect(c1).toContain(LEVEL_SPECS.C1.grammarFocus);
  });
});
