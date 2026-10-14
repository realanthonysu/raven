/**
 * db 纯工具函数单测 —— 存储时间戳解析入口（parseDbTimestamp）与本地日期键
 * （getLocalDate）。
 *
 * parseDbTimestamp 是全仓唯一的 SQLite 存储时间戳解析入口（C2：数据库时间单一归属）：
 * history.created_at 与 words.next_review_at（011 迁移起）同为 UTC、无时区标记存储，
 * 此处为其直接锚点 —— 实现漂移（如误按本地时间解析、漏补 "Z"）由本文件第一时间看见。
 */

import { describe, expect, it } from "vitest";
import * as utils from "./utils";

const { getLocalDate, parseDbTimestamp } = utils;

// ============================================================================
// Helpers
// ============================================================================

/**
 * 独立推导本地日历日的 oracle：把时刻减去时区偏移平移后读 UTC 字段，
 * 得到与"读本地字段"相同的日历日（与 getLocalDate 的实现路径不同，可交叉验证）。
 */
function localDateOracle(d: Date): string {
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// ============================================================================
// parseDbTimestamp
// ============================================================================

describe("parseDbTimestamp", () => {
  it("parses space-separated SQLite format as UTC (not local)", () => {
    // 与运行器时区无关：固定输入必须对应固定 UTC 瞬间
    expect(parseDbTimestamp("2026-07-01 10:00:00").getTime()).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
    expect(parseDbTimestamp("2026-07-01 10:00:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });

  it("parses T-separated format identically to space-separated", () => {
    expect(parseDbTimestamp("2026-07-01T10:00:00").getTime()).toBe(
      parseDbTimestamp("2026-07-01 10:00:00").getTime(),
    );
  });

  it("parses date-only strings as UTC midnight", () => {
    expect(parseDbTimestamp("2026-01-01").getTime()).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it("keeps sub-day precision so ordering comparisons are exact", () => {
    const early = parseDbTimestamp("2026-07-01 23:59:59").getTime();
    const late = parseDbTimestamp("2026-07-02 00:00:00").getTime();
    expect(late - early).toBe(1000);
  });

  it("returns Invalid Date for garbage input", () => {
    expect(Number.isNaN(parseDbTimestamp("not-a-date").getTime())).toBe(true);
    expect(Number.isNaN(parseDbTimestamp("").getTime())).toBe(true);
  });

  it("returns Invalid Date when the caller pre-appends Z (raw stored value only)", () => {
    // 契约：入库串从不带 "Z" 后缀（UTC 无时区标记存储），调用方必须原样传入；
    // 自行补 "Z" 会得到双 "Z" 的 Invalid Date —— 以此锚定"单一入口负责补 Z"
    expect(Number.isNaN(parseDbTimestamp("2026-07-01T10:00:00Z").getTime())).toBe(true);
  });
});

// ============================================================================
// 单一入口不变量
// ============================================================================

describe("db utils 模块表面", () => {
  it("exposes exactly one stored-timestamp parser (no parseDbUtcTimestamp)", () => {
    // C2 收敛：此前 parseDbTimestamp / parseDbUtcTimestamp 实现体逐字节相同、
    // 各有一个深路径调用方；删除后者后 utils 内只允许一个解析入口
    const parsers = Object.keys(utils).filter((k) => k.toLowerCase().includes("parsedb"));
    expect(parsers).toEqual(["parseDbTimestamp"]);
  });
});

// ============================================================================
// getLocalDate
// ============================================================================

describe("getLocalDate", () => {
  it("formats local-constructed dates as YYYY-MM-DD", () => {
    expect(getLocalDate(new Date(2026, 6, 23))).toBe("2026-07-23");
    expect(getLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("uses the local calendar day across the UTC midnight boundary", () => {
    // UTC 00:30：UTC+8 是当天 08:30（同一天），UTC-5 是前一天 19:30（差一天）——
    // 两种运行器下取值都必须等于本地日历日（oracle 交叉验证），而非 UTC 日期
    const utcMidnight = new Date(Date.UTC(2026, 6, 1, 0, 30));
    expect(getLocalDate(utcMidnight)).toBe(localDateOracle(utcMidnight));
    // 且与 UTC 日历日的差值不超过一天（防止退化为 toISOString 或漏时区）
    const utcDate = "2026-07-01";
    const local = getLocalDate(utcMidnight);
    expect([utcDate, "2026-06-30"]).toContain(local);
  });
});
