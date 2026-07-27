import { describe, expect, it } from "vitest";
import { type GoalDto, goalsToRecord } from "./GoalsContext";

describe("goalsToRecord", () => {
  it("converts GoalDto array to Record<string, number>", () => {
    const goals: GoalDto[] = [
      { goal_type: "reading", target: 30 },
      { goal_type: "writing", target: 20 },
    ];
    const result = goalsToRecord(goals);
    expect(result).toEqual({ reading: 30, writing: 20 });
  });

  it("returns empty object for empty array", () => {
    expect(goalsToRecord([])).toEqual({});
  });

  it("handles single goal", () => {
    const result = goalsToRecord([{ goal_type: "listening", target: 15 }]);
    expect(result).toEqual({ listening: 15 });
  });

  it("overwrites duplicate goal types with last value", () => {
    const goals: GoalDto[] = [
      { goal_type: "reading", target: 10 },
      { goal_type: "reading", target: 20 },
    ];
    const result = goalsToRecord(goals);
    expect(result.reading).toBe(20);
  });
});
