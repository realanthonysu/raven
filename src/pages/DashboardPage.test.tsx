import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";

// Mock db module
vi.mock("@/lib/db", () => ({
  getHistoryList: vi.fn(),
  getHistoryOldestDate: vi.fn(),
  getHistoryWithResults: vi.fn(),
  getLearningStreak: vi.fn(),
  getReviewStats: vi.fn(),
  // 与真实实现一致：history.created_at 为 UTC，补 "Z" 后按 UTC 解析
  parseDbTimestamp: (s: string) => new Date(`${s.includes(" ") ? s.replace(" ", "T") : s}Z`),
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
  getHistoryWithResults,
  getLearningStreak,
  getReviewStats,
} from "@/lib/db";
import DashboardPage from "./DashboardPage";

function makeRecord(
  id: number,
  type: HistoryRecord["type"],
  inputText: string,
  createdAt: string,
): HistoryRecord {
  return { id, type, input_text: inputText, result: "", graph_data: null, created_at: createdAt };
}

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
    vi.mocked(getHistoryWithResults).mockResolvedValue({ records: [], resultById: new Map() });
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

  it("fetches writing/exercise/listening+speaking data through the unified query", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("8")).toBeInTheDocument();
    });

    // 弱项分析 + 时间线摘要合并后的最小查询集：
    // 写作（20 条，覆盖原 getRecentCorrectResults 与时间线 correct 查询的重叠）、
    // 练习（50 条，掌握度窗口）、听力+口语合并（5 条，仅时间线摘要）
    expect(getHistoryWithResults).toHaveBeenCalledWith(["correct", "writing"], 20);
    expect(getHistoryWithResults).toHaveBeenCalledWith("exercise", 50);
    expect(getHistoryWithResults).toHaveBeenCalledWith(["listening", "speaking"], 5);
    // 时间线轻量记录仍走独立调用
    expect(getHistoryList).toHaveBeenCalledWith(undefined, 5);
    expect(getHistoryOldestDate).toHaveBeenCalled();
  });

  it("renders timeline score summary paired by record id", async () => {
    const exerciseResult = JSON.stringify({
      category: "时态错误",
      exercises: [
        { type: "fill", question: "q1", answer: "a", explanation: "" },
        { type: "fill", question: "q2", answer: "b", explanation: "" },
        { type: "fill", question: "q3", answer: "c", explanation: "" },
        { type: "fill", question: "q4", answer: "d", explanation: "" },
      ],
      userAnswers: ["a", "b", "x", "x"],
      score: 2,
    });
    vi.mocked(getHistoryList).mockResolvedValue([
      makeRecord(7, "exercise", "practice text", "2026-07-05T10:00:00"),
    ]);
    vi.mocked(getHistoryWithResults).mockImplementation(async (types) => {
      const list = Array.isArray(types) ? types : [types];
      if (list.includes("exercise")) {
        return { records: [], resultById: new Map([[7, exerciseResult]]) };
      }
      return { records: [], resultById: new Map() };
    });

    renderDashboard();

    // 时间线行按 id 配对出分数摘要：类别预览 + 得分文本
    await waitFor(() => {
      expect(screen.getByText("时态错误 训练")).toBeInTheDocument();
    });
    expect(screen.getByText("2/4")).toBeInTheDocument();
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
