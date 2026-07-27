import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db module
vi.mock("@/lib/db", () => ({
  getHistoryList: vi.fn(),
  getHistoryOldestDate: vi.fn(),
  getRecentCorrectResults: vi.fn(),
  getLearningStreak: vi.fn(),
  getReviewStats: vi.fn(),
}));

// Mock react-router-dom navigation
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

import {
  getHistoryList,
  getHistoryOldestDate,
  getLearningStreak,
  getRecentCorrectResults,
  getReviewStats,
} from "@/lib/db";
import DashboardPage from "./DashboardPage";

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReviewStats).mockResolvedValue({
      total: 50,
      newCount: 20,
      learningCount: 15,
      masteredCount: 15,
      dueCount: 8,
    });
    vi.mocked(getLearningStreak).mockResolvedValue(5);
    vi.mocked(getHistoryList).mockResolvedValue([]);
    vi.mocked(getRecentCorrectResults).mockResolvedValue([]);
    vi.mocked(getHistoryOldestDate).mockResolvedValue(null);
  });

  it("displays review due count after loading", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("8")).toBeInTheDocument();
    });
  });

  it("displays learning streak", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText(/已连续学习/)).toBeInTheDocument();
    });
  });

  it("displays due count section title", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("待复习词汇")).toBeInTheDocument();
    });
  });

  it("handles data fetch error gracefully", async () => {
    vi.mocked(getReviewStats).mockRejectedValue(new Error("DB error"));
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("DB error")).toBeInTheDocument();
    });
  });

  it("shows retry button on error", async () => {
    vi.mocked(getReviewStats).mockRejectedValue(new Error("DB error"));
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("重试")).toBeInTheDocument();
    });
  });

  it("shows greeting text", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/好/)).toBeInTheDocument();
    });
  });

  it("renders streak zero state", async () => {
    vi.mocked(getLearningStreak).mockResolvedValue(0);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("开始今天的学习吧")).toBeInTheDocument();
    });
  });

  it("renders empty vocabulary state", async () => {
    vi.mocked(getReviewStats).mockResolvedValue({
      total: 0,
      newCount: 0,
      learningCount: 0,
      masteredCount: 0,
      dueCount: 0,
    });
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/生词本暂无词汇/)).toBeInTheDocument();
    });
  });
});
