/**
 * Rust 写入白名单 ↔ TS 枚举 契约测试（repository/mod.rs 的 5 组 validate_*）。
 *
 * settings-keys.test.ts 已把「双端登记」机器化锁定在 settings key 一组；
 * 但 repository 层还有 5 组写入白名单（review_status / record_type / goal_type /
 * difficulty_level / word_level），TS 侧各有一份对应的联合类型或常量——此前任一侧
 * 增删取值，另一侧只能在运行时以「写入被 Validation 拒绝」暴露。本测试读
 * repository/mod.rs 源码提取各 `validate_*` 函数内的 `const VALID` 数组，
 * 与 TS 侧单一来源做**双向集合相等**断言，漂移在 CI 即刻暴露。
 *
 * 各组 TS 锚点（单一来源）：
 * - record_type      ↔ Object.keys(typeConfig)        （lib/type-config.tsx，HISTORY_TYPE_SET 同源）
 * - goal_type        ↔ GOAL_TYPES                     （lib/constants.ts）
 * - review_status    ↔ ReviewStatusSchema.options     （lib/schemas.ts；REVIEW_STATUS 常量是
 *                                                       TS 侧第二份副本，一并锁定）
 * - difficulty_level ↔ LEVEL_CODES                    （lib/levels.ts，级别体系单一事实来源）
 * - word_level       ↔ WordLevelSchema.options        （lib/schemas.ts）
 *
 * 双向校验：
 * - Rust 有、TS 无 → TS 侧缺失（或 Rust 侧是死值，应两侧同删）；
 * - TS 有、Rust 无 → Rust 白名单漏登记（运行时写入会被 Validation 错误拒绝）。
 *
 * 提取方式：从 `fn validate_<name>(` 起截取第一个 `const VALID: &[&str] = &[...];`
 * 块再匹配字符串字面量——五个函数各自在函数体内声明同名 VALID，必须以函数名为锚，
 * 不能全文匹配。若 Rust 侧重命名函数或改用其他结构（如 match 分支），本测试会
 * 显式抛错提示更新提取逻辑，而非静默通过。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOAL_TYPES, REVIEW_STATUS } from "@/lib/constants";
import { LEVEL_CODES } from "@/lib/levels";
import { ReviewStatusSchema, WordLevelSchema } from "@/lib/schemas";
import { typeConfig } from "@/lib/type-config";

/** repository 白名单所在源文件（vitest 的 cwd 是仓库根） */
const REPOSITORY_RS = path.resolve(process.cwd(), "src-tauri/src/repository/mod.rs");

/**
 * 从 repository/mod.rs 提取指定 `validate_*` 函数的 VALID 白名单字面量。
 *
 * 以 `fn <fnName>(` 为锚（带左括号，避免命中测试函数名的前缀子串），
 * 取其后第一个 `const VALID: &[&str] = &[ ... ];` 块。
 */
function extractRustValidList(fnName: string): string[] {
  const source = readFileSync(REPOSITORY_RS, "utf-8");
  const anchor = `fn ${fnName}(`;
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(
      `未在 repository/mod.rs 中找到函数 ${fnName}——若 Rust 侧重命名了该校验函数，请同步更新本测试的锚点。`,
    );
  }
  const match = source.slice(start).match(/const VALID:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(
      `${fnName} 内未找到 \`const VALID: &[&str] = &[...];\` 白名单——若改用其他结构（如 match 分支），请更新本测试的提取逻辑。`,
    );
  }
  const literals = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error(`${fnName} 的 VALID 数组为空或未提取到任何字符串字面量，请人工核对。`);
  }
  return literals;
}

/**
 * 双向集合相等断言：失败信息直接点明枚举组名、方向与具体值。
 * 顺带锁定两侧无重复值与总数一致（重复项会让集合比较漏报）。
 */
function assertSameSet(enumLabel: string, rustValues: string[], tsValues: readonly string[]): void {
  const rustSet = new Set(rustValues);
  const tsSet = new Set(tsValues);
  const rustOnly = rustValues.filter((v) => !tsSet.has(v));
  const tsOnly = tsValues.filter((v) => !rustSet.has(v));

  expect(
    rustOnly,
    `[${enumLabel}] Rust 白名单多出、TS 侧缺失的值：${rustOnly.join(", ")}（TS 缺失则补登记；是死值则两侧同删）`,
  ).toEqual([]);
  expect(
    tsOnly,
    `[${enumLabel}] TS 侧有、Rust 白名单漏登记的值：${tsOnly.join(", ")}（运行时写入会被 Validation 拒绝）`,
  ).toEqual([]);
  expect(rustSet.size, `[${enumLabel}] Rust 白名单含重复值：${rustValues.join(", ")}`).toBe(
    rustValues.length,
  );
  expect(rustValues.length, `[${enumLabel}] 两侧总数不一致（存在重复值或上述差异未被捕获）`).toBe(
    tsValues.length,
  );
}

describe("repository 写入白名单 ↔ TS 枚举契约", () => {
  it("record_type：validate_record_type ↔ typeConfig 键", () => {
    assertSameSet(
      "record_type",
      extractRustValidList("validate_record_type"),
      Object.keys(typeConfig),
    );
  });

  it("goal_type：validate_goal_type ↔ GOAL_TYPES", () => {
    assertSameSet("goal_type", extractRustValidList("validate_goal_type"), GOAL_TYPES);
  });

  it("review_status：validate_review_status ↔ ReviewStatusSchema", () => {
    assertSameSet(
      "review_status",
      extractRustValidList("validate_review_status"),
      ReviewStatusSchema.options,
    );
  });

  it("review_status：validate_review_status ↔ REVIEW_STATUS 常量（TS 侧第二份副本）", () => {
    assertSameSet(
      "review_status",
      extractRustValidList("validate_review_status"),
      Object.values(REVIEW_STATUS),
    );
  });

  it("difficulty_level：validate_difficulty_level ↔ LEVEL_CODES", () => {
    assertSameSet(
      "difficulty_level",
      extractRustValidList("validate_difficulty_level"),
      LEVEL_CODES,
    );
  });

  it("word_level：validate_word_level ↔ WordLevelSchema", () => {
    assertSameSet(
      "word_level",
      extractRustValidList("validate_word_level"),
      WordLevelSchema.options,
    );
  });
});
