import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLearningGoals,
  getLearningStreak,
  getSidebarData,
  recordLearningActivity,
  recordLearningActivitySafe,
  setLearningGoal,
} from "./learning";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("learning db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recordLearningActivity calls invoke with date and activity", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await recordLearningActivity("writing");
    expect(invoke).toHaveBeenCalledWith("db_record_learning_activity", {
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      activity: "writing",
    });
  });

  it("recordLearningActivitySafe does not throw on error", () => {
    vi.mocked(invoke).mockRejectedValue(new Error("DB error"));
    expect(() => recordLearningActivitySafe("reading")).not.toThrow();
  });

  it("getLearningStreak returns streak count", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const result = await getLearningStreak();
    expect(invoke).toHaveBeenCalledWith("db_get_all_streaks");
    expect(typeof result).toBe("number");
  });

  it("getLearningStreak throws on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getLearningStreak(controller.signal)).rejects.toThrow();
  });

  it("getLearningGoals returns record from goal dtos", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { goal_type: "review", target: 20 },
      { goal_type: "exercise", target: 5 },
    ]);
    const result = await getLearningGoals();
    expect(result).toEqual({ review: 20, exercise: 5 });
  });

  it("setLearningGoal calls invoke with correct params", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await setLearningGoal("reading", 30);
    expect(invoke).toHaveBeenCalledWith("db_set_learning_goal", {
      goalType: "reading",
      target: 30,
    });
  });

  it("getSidebarData returns structured data", async () => {
    vi.mocked(invoke).mockResolvedValue({
      review_stats: {
        total: 10,
        new_count: 3,
        learning_count: 5,
        mastered_count: 2,
        due_count: 4,
      },
      streak: 7,
      goals: [{ goal_type: "review", target: 20 }],
      today_activities: '{"writing": 1}',
    });
    const result = await getSidebarData();
    expect(result.reviewStats.total).toBe(10);
    expect(result.reviewStats.dueCount).toBe(4);
    expect(result.streak).toBe(7);
    expect(result.goals).toEqual({ review: 20 });
    expect(result.todayActivities).toEqual({ writing: 1 });
  });

  it("getSidebarData handles null today_activities", async () => {
    vi.mocked(invoke).mockResolvedValue({
      review_stats: { total: 0, new_count: 0, learning_count: 0, mastered_count: 0, due_count: 0 },
      streak: 0,
      goals: [],
      today_activities: null,
    });
    const result = await getSidebarData();
    expect(result.todayActivities).toEqual({});
  });

  it("getSidebarData handles invalid JSON in today_activities", async () => {
    vi.mocked(invoke).mockResolvedValue({
      review_stats: { total: 0, new_count: 0, learning_count: 0, mastered_count: 0, due_count: 0 },
      streak: 0,
      goals: [],
      today_activities: "invalid json{",
    });
    const result = await getSidebarData();
    expect(result.todayActivities).toEqual({});
  });
});
