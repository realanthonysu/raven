import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateAndUpdateReview, getReviewStats, getReviewWords } from "./review";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("review db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getReviewStats maps DTO to camelCase", async () => {
    vi.mocked(invoke).mockResolvedValue({
      total: 50,
      new_count: 10,
      learning_count: 25,
      mastered_count: 15,
      due_count: 8,
    });
    const result = await getReviewStats();
    expect(result).toEqual({
      total: 50,
      newCount: 10,
      learningCount: 25,
      masteredCount: 15,
      dueCount: 8,
    });
  });

  it("getReviewStats throws on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getReviewStats(controller.signal)).rejects.toThrow();
  });

  it("getReviewWords calls invoke with limit", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getReviewWords(10);
    expect(invoke).toHaveBeenCalledWith("db_get_review_words", { limit: 10 });
  });

  it("getReviewWords uses default limit of 20", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getReviewWords();
    expect(invoke).toHaveBeenCalledWith("db_get_review_words", { limit: 20 });
  });

  it("calculateAndUpdateReview calls invoke with correct params", async () => {
    const card = {
      stability: 1.2,
      difficulty: 5.5,
      elapsed_days: 0,
      scheduled_days: 2,
      reps: 1,
      lapses: 0,
      state: 2,
    };
    vi.mocked(invoke).mockResolvedValue({
      status: "learning",
      interval: 4,
      next_review_at: "2026-08-01",
      card,
    });
    await calculateAndUpdateReview(5, card, "good");
    expect(invoke).toHaveBeenCalledWith("db_calculate_and_update_review", {
      id: 5,
      card,
      rating: "good",
    });
  });
});
