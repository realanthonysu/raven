/**
 * Sidebar component tests.
 * Mocks db (getSidebarData) and GoalsContext (useGoals).
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock db module — must be declared before imports that use it
vi.mock("@/lib/db", () => ({
  getSidebarData: vi.fn(),
}));

// Mock GoalsContext
vi.mock("@/contexts/GoalsContext", async (importOriginal) => ({
  // useGoals 的真实实现会校验 Provider，这里整体替换为可控 mock
  ...(await importOriginal<object>()),
  useGoals: vi.fn(),
}));

import { useGoals } from "@/contexts/GoalsContext";
import { getSidebarData } from "@/lib/db";
import { markTaskCompleted } from "@/lib/task-status";
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
      // 纯读取方契约：goals 为 Record<string, number>（getLearningGoals 原生形状），
      // 且接口不再暴露 setter——Sidebar 没有任何写回路径
      goals: {},
      refreshGoals: vi.fn(),
    });
    vi.mocked(getSidebarData).mockResolvedValue(defaultSidebarData);
  });

  afterEach(() => {
    // 本文件只有任务完成测试使用假定时器；无条件还原对其他测试无副作用
    vi.useRealTimers();
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

  // ── 纯读取方：目标进度条完全来自 context ──

  it("renders goal progress bars from context goals and sidebar activities", async () => {
    vi.mocked(useGoals).mockReturnValue({
      goals: { review: 10, writing: 2 },
      refreshGoals: vi.fn(),
    });
    vi.mocked(getSidebarData).mockResolvedValue({
      ...defaultSidebarData,
      todayActivities: { review: 4 },
    });

    renderSidebar();

    await waitFor(() => {
      // “复习”同时也是导航项文案，这里只要求进度区出现即可
      expect(screen.getAllByText("复习").length).toBeGreaterThanOrEqual(1);
    });
    // 复习：4/10（今日活动来自 getSidebarData，目标值来自 useGoals）
    expect(screen.getByText("4/10")).toBeInTheDocument();
    // 写作：0/2（无活动记录按 0 计）
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("ignores the goals field of getSidebarData (no second producer path)", async () => {
    vi.mocked(useGoals).mockReturnValue({
      goals: {},
      refreshGoals: vi.fn(),
    });
    vi.mocked(getSidebarData).mockResolvedValue({
      ...defaultSidebarData,
      // getSidebarData 自带的目标不应被 Sidebar 采用（context 为空 → 不渲染进度区）
      goals: { review: 99 },
      todayActivities: {},
    });

    renderSidebar();

    await waitFor(() => {
      expect(getSidebarData).toHaveBeenCalled();
    });
    expect(screen.queryByText("今日目标")).not.toBeInTheDocument();
    // 若误用 getSidebarData 的 goals，会渲染出 "0/99" 的进度行
    expect(screen.queryByText("0/99")).not.toBeInTheDocument();
  });

  // ── 页内任务完成后的刷新（原仅在 pathname 变化时拉取）──

  it("refreshes sidebar data and goals after an in-page task completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const refreshGoals = vi.fn();
    vi.mocked(useGoals).mockReturnValue({ goals: {}, refreshGoals });

    renderSidebar();

    // 挂载时的导航刷新（第 1 次）
    await waitFor(() => {
      expect(getSidebarData).toHaveBeenCalledTimes(1);
    });

    // 页内任务完成：completed 槽位数 0 → 1
    act(() => {
      markTaskCompleted("writing");
    });

    // 延迟窗口内不应刷新（等 recordLearningActivity 落库）
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(getSidebarData).toHaveBeenCalledTimes(1);
    expect(refreshGoals).not.toHaveBeenCalled();

    // 越过约 2s 延迟后完成刷新，且刷新不被导航防抖吞掉
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getSidebarData).toHaveBeenCalledTimes(2);
    });
    expect(refreshGoals).toHaveBeenCalled();
  });
});
