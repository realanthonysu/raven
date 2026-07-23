import { describe, expect, it } from "vitest";
import { aggregateCorrections, countStreak, getLocalDate } from "./db";

// ─── getLocalDate ─────────────────────────────────────────────────

describe("getLocalDate", () => {
  it("formats date as YYYY-MM-DD in local timezone", () => {
    const date = new Date(2026, 6, 23); // July 23, 2026 (month is 0-indexed)
    expect(getLocalDate(date)).toBe("2026-07-23");
  });

  it("pads single-digit month and day", () => {
    const date = new Date(2026, 0, 5); // January 5
    expect(getLocalDate(date)).toBe("2026-01-05");
  });

  it("handles year boundary", () => {
    const date = new Date(2025, 11, 31); // December 31
    expect(getLocalDate(date)).toBe("2025-12-31");
  });
});

// ─── aggregateCorrections ─────────────────────────────────────────

describe("aggregateCorrections", () => {
  it("returns empty string for empty input", () => {
    expect(aggregateCorrections([])).toBe("");
  });

  it("returns empty string when all entries have no corrections", () => {
    expect(aggregateCorrections([{ corrections: undefined }, { corrections: [] }])).toBe("");
  });

  it("aggregates categories and sorts by frequency", () => {
    const input = [
      { corrections: [{ category: "时态", original: "go", corrected: "goes" }] },
      { corrections: [{ category: "主谓一致", original: "is", corrected: "are" }] },
      { corrections: [{ category: "时态", original: "went", corrected: "go" }] },
      { corrections: [{ category: "时态", original: "run", corrected: "ran" }] },
    ];
    const result = aggregateCorrections(input);

    expect(result).toContain("时态(3次)");
    expect(result).toContain("主谓一致(1次)");
    // 时态 should come first (higher count)
    expect(result.indexOf("时态")).toBeLessThan(result.indexOf("主谓一致"));
  });

  it("limits to top 3 categories", () => {
    const input = [
      { corrections: [{ category: "A", original: "a", corrected: "b" }] },
      { corrections: [{ category: "B", original: "c", corrected: "d" }] },
      { corrections: [{ category: "C", original: "e", corrected: "f" }] },
      { corrections: [{ category: "D", original: "g", corrected: "h" }] },
    ];
    const result = aggregateCorrections(input);

    expect(result).toContain("A(");
    expect(result).toContain("B(");
    expect(result).toContain("C(");
    expect(result).not.toContain("D(");
  });

  it("includes examples (up to 2 per category)", () => {
    const input = [
      {
        corrections: [
          { category: "时态", original: "She go", corrected: "She goes" },
          { category: "时态", original: "He run", corrected: "He runs" },
          { category: "时态", original: "It work", corrected: "It works" }, // 3rd example, should be excluded
        ],
      },
    ];
    const result = aggregateCorrections(input);

    expect(result).toContain("She go -> She goes");
    expect(result).toContain("He run -> He runs");
    expect(result).not.toContain("It work -> It works");
  });

  it("skips entries with empty category", () => {
    const input = [
      { corrections: [{ category: "", original: "a", corrected: "b" }] },
      { corrections: [{ category: "时态", original: "c", corrected: "d" }] },
    ];
    const result = aggregateCorrections(input);

    expect(result).toContain("时态(1次)");
  });

  it("skips null/undefined correction entries", () => {
    const input = [null as unknown, undefined as unknown, { corrections: null }] as Array<{
      corrections?: Array<{ category: string; original: string; corrected: string }>;
    }>;
    expect(aggregateCorrections(input)).toBe("");
  });
});

// ─── countStreak ──────────────────────────────────────────────────

describe("countStreak", () => {
  it("returns 0 for empty rows", () => {
    const today = new Date(2026, 6, 23);
    expect(countStreak([], today)).toBe(0);
  });

  it("counts consecutive days from today", () => {
    const today = new Date(2026, 6, 23);
    const rows = [{ date: "2026-07-23" }, { date: "2026-07-22" }, { date: "2026-07-21" }];
    expect(countStreak(rows, today)).toBe(3);
  });

  it("breaks at first gap", () => {
    const today = new Date(2026, 6, 23);
    const rows = [
      { date: "2026-07-23" },
      { date: "2026-07-22" },
      // gap: 2026-07-21 missing
      { date: "2026-07-20" },
    ];
    expect(countStreak(rows, today)).toBe(2);
  });

  it("returns 0 when today is missing", () => {
    const today = new Date(2026, 6, 23);
    const rows = [{ date: "2026-07-22" }, { date: "2026-07-21" }];
    expect(countStreak(rows, today)).toBe(0);
  });

  it("returns 1 for single day matching today", () => {
    const today = new Date(2026, 6, 23);
    const rows = [{ date: "2026-07-23" }];
    expect(countStreak(rows, today)).toBe(1);
  });

  it("handles month boundary correctly", () => {
    const today = new Date(2026, 6, 1); // July 1
    const rows = [{ date: "2026-07-01" }, { date: "2026-06-30" }, { date: "2026-06-29" }];
    expect(countStreak(rows, today)).toBe(3);
  });

  it("handles year boundary correctly", () => {
    const today = new Date(2026, 0, 1); // January 1, 2026
    const rows = [{ date: "2026-01-01" }, { date: "2025-12-31" }, { date: "2025-12-30" }];
    expect(countStreak(rows, today)).toBe(3);
  });
});
