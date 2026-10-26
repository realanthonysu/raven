/**
 * SETTINGS_KEYS ↔ Rust ALLOWED_SETTINGS 契约测试。
 *
 * 这是 AGENTS.md 所述「新 settings key 必须登记进 src-tauri 的 ALLOWED_SETTINGS，
 * 否则 db_get_setting/db_set_setting 会在运行时拒绝」这条人工警告的机器化守卫：
 * Rust 白名单是 settings key 的唯一守门人，本测试保证 TS 侧单一来源
 * （SETTINGS_KEYS）与之**集合相等**，漂移在 CI 即刻暴露，无需等到运行时。
 *
 * 双向校验：
 * - Rust 有、TS 无 → 说明 TS 侧缺失（或 Rust 侧是无人使用的死 key，应两侧同删）；
 * - TS 有、Rust 无 → 说明 Rust 白名单漏登记（运行时写入会被 Validation 错误拒绝）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_KEYS } from "./settings-keys";

/** Rust 白名单所在源文件（vitest 的 cwd 是仓库根） */
const SETTINGS_RS = path.resolve(process.cwd(), "src-tauri/src/commands/settings.rs");

/**
 * 从 settings.rs 源码中提取 ALLOWED_SETTINGS 数组里的全部字符串字面量。
 *
 * 只截取 `const ALLOWED_SETTINGS: &[&str] = &[ ... ];` 块再匹配 "..."，
 * 避免把文件其余部分（错误信息模板、测试断言里的 key 字面量）误收进来。
 */
function extractRustAllowedSettings(): string[] {
  const source = readFileSync(SETTINGS_RS, "utf-8");
  const match = source.match(/const ALLOWED_SETTINGS:\s*&\[&str\]\s*=\s*&\[(.*?)\];/s);
  if (!match) {
    throw new Error(
      "未在 settings.rs 中找到 ALLOWED_SETTINGS 数组——若 Rust 侧重命名了该常量，请同步更新本测试的提取正则。",
    );
  }
  const literals = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error("ALLOWED_SETTINGS 数组为空或未提取到任何字符串字面量，请人工核对。");
  }
  return literals;
}

describe("SETTINGS_KEYS ↔ ALLOWED_SETTINGS 契约", () => {
  it("两侧集合相等（Rust 多出 = TS 缺失/死 key；TS 多出 = Rust 白名单漏登记）", () => {
    const rustKeys = extractRustAllowedSettings();
    // 显式放宽为 string[]：tsKeys 是字面量联合类型，includes(string) 需要宽侧比较
    const tsKeys: string[] = Object.values(SETTINGS_KEYS);

    const rustOnly = rustKeys.filter((k) => !tsKeys.includes(k));
    const tsOnly = tsKeys.filter((k) => !rustKeys.includes(k));

    // 双向分别报告，出错时能直接看出该往哪一侧补登记
    expect(
      rustOnly,
      "Rust 白名单多出、TS 侧 SETTINGS_KEYS 缺失的 key（TS 缺失则为死 key，应两侧同删）",
    ).toEqual([]);
    expect(
      tsOnly,
      "SETTINGS_KEYS 有、Rust ALLOWED_SETTINGS 漏登记的 key（运行时写入会被拒绝）",
    ).toEqual([]);

    // 顺带锁定数量与无重复：白名单是白名单，不该藏着重复项
    expect(new Set(rustKeys).size).toBe(rustKeys.length);
    expect(rustKeys.length).toBe(tsKeys.length);
  });
});
