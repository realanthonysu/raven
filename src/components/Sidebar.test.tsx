/**
 * Sidebar component tests.
 * Mocks db (getSidebarData) and GoalsContext (useGoals).
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db module — must be declared before imports that use it
vi.mock("@/lib/db", () => ({
  getSidebarData: vi.fn(),
}));

// Mock GoalsContext
vi.mock("@/contexts/GoalsContext", () => ({
  useGoals: vi.fn(),
}));

import { useGoals } from "@/contexts/GoalsContext";
import { getSidebarData } from "@/lib/db";
import { Sidebar } from "./Sidebar";

const defaultSidebarData = {
  reviewStats: { total: 0, newCount: 0, learningCount: 0, masteredCount: 0, dueCount: 0 },
  streak: 0,
  goals: {},
  todayActivities: {},
};

function renderSidebar(route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useGoals).mockReturnValue({
      goals: [],
      setGoals: vi.fn(),
      refreshGoals: vi.fn(),
    });
    vi.mocked(getSidebarData).mockResolvedValue(defaultSidebarData);
  });

  it("renders Raven title", () => {
    renderSidebar();
    expect(screen.getByText("Raven")).toBeInTheDocument();
  });

  it("renders all navigation items", async () => {
    renderSidebar();
    const labels = [
      "仪表盘",
      "写作训练",
      "阅读训练",
      "听力训练",
      "口语训练",
      "生词本",
      "复习",
      "历史记录",
      "学习分析",
    ];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders settings link", () => {
    renderSidebar();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("renders streak when streak > 0", async () => {
    vi.mocked(getSidebarData).mockResolvedValue({
      ...defaultSidebarData,
      streak: 7,
    });
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.getByText(/连续学习/)).toBeInTheDocument();
    });
  });

  it("does not render streak when streak is 0", async () => {
    renderSidebar();
    // The streak text should not appear initially; after data loads it still is 0
    await waitFor(() => {
      expect(screen.queryByText(/连续学习/)).not.toBeInTheDocument();
    });
  });

  it("renders the English subtitle", () => {
    renderSidebar();
    expect(screen.getByText("英语学习助手")).toBeInTheDocument();
  });

  it("shows due review badge when dueCount > 0", async () => {
    vi.mocked(getSidebarData).mockResolvedValue({
      ...defaultSidebarData,
      reviewStats: { total: 10, newCount: 2, learningCount: 5, masteredCount: 3, dueCount: 4 },
    });
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText("4")).toBeInTheDocument();
    });
  });
});
