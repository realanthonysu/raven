import { describe, expect, it } from "vitest";
import { cn, getScoreBgColor, getScoreColor } from "./utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("resolves Tailwind conflicts", () => {
    expect(cn("p-2 p-4")).toBe("p-4");
  });

  it("handles conditional classes", () => {
    expect(cn("base", false && "hidden", "extra")).toBe("base extra");
  });
});

describe("getScoreColor", () => {
  it("returns green for values >= high threshold", () => {
    expect(getScoreColor(80, 80, 60)).toBe("text-green-600 dark:text-green-400");
    expect(getScoreColor(100, 80, 60)).toBe("text-green-600 dark:text-green-400");
    expect(getScoreColor(90, 80, 60)).toBe("text-green-600 dark:text-green-400");
  });

  it("returns yellow for values >= low threshold and < high threshold", () => {
    expect(getScoreColor(60, 80, 60)).toBe("text-yellow-600 dark:text-yellow-400");
    expect(getScoreColor(70, 80, 60)).toBe("text-yellow-600 dark:text-yellow-400");
    expect(getScoreColor(79, 80, 60)).toBe("text-yellow-600 dark:text-yellow-400");
  });

  it("returns red for values < low threshold", () => {
    expect(getScoreColor(59, 80, 60)).toBe("text-red-600 dark:text-red-400");
    expect(getScoreColor(0, 80, 60)).toBe("text-red-600 dark:text-red-400");
    expect(getScoreColor(30, 80, 60)).toBe("text-red-600 dark:text-red-400");
  });

  it("works with different thresholds", () => {
    expect(getScoreColor(4, 4, 3)).toBe("text-green-600 dark:text-green-400");
    expect(getScoreColor(3, 4, 3)).toBe("text-yellow-600 dark:text-yellow-400");
    expect(getScoreColor(2, 4, 3)).toBe("text-red-600 dark:text-red-400");
  });
});

describe("getScoreBgColor", () => {
  it("returns green background for values >= high threshold", () => {
    expect(getScoreBgColor(80, 80, 60)).toBe("bg-green-500/10");
    expect(getScoreBgColor(100, 80, 60)).toBe("bg-green-500/10");
  });

  it("returns yellow background for mid-range values", () => {
    expect(getScoreBgColor(60, 80, 60)).toBe("bg-yellow-500/10");
    expect(getScoreBgColor(79, 80, 60)).toBe("bg-yellow-500/10");
  });

  it("returns red background for values < low threshold", () => {
    expect(getScoreBgColor(59, 80, 60)).toBe("bg-red-500/10");
    expect(getScoreBgColor(0, 80, 60)).toBe("bg-red-500/10");
  });
});
