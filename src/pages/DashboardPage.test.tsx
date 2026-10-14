import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";

// 部分 mock：IPC 函数替换为 vi.fn()，parseDbTimestamp 等纯函数走真实实现——
// 存储时间戳解析语义（UTC 无时区标记）若漂移，本测试第一时间可见
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getHistoryList: vi.fn(),
  getHistoryOldestDate: vi.fn(),
  getHistoryWithResults: vi.fn(),
  getLearningStreak: vi.fn(),
  getReviewStats: vi.fn(),
}));

// Mock react-router navigation
const mockNavigate = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
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

  afterEach(() => {
    // 回归测试用假计时器固定"现在"，用后复位，避免影响后续用例
    vi.useRealTimers();
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
    // 练习（50 条，掌握度算法需每类别最近 2-3 次记录）、听力+口语合并（5 条，仅时间线摘要）
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

  it("labels a record created in the local early-morning window as 今天 (UTC-naive storage)", async () => {
    // 回归（C2）：formatRelativeDate 曾对裸 created_at 直接 new Date()，按本地时间
    // 解释 UTC 存储串 —— UTC+8 用户本地 00:00-08:00 创建的记录当晚被标成"昨天"
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 23, 0, 0)); // 本地 2026-10-14 23:00
    // 本地今天 01:00 对应的 UTC 存储串（UTC+8 下为 "2026-10-13 17:00:00"）
    const stored = new Date(2026, 9, 14, 1, 0, 0).toISOString().replace("T", " ").slice(0, 19);
    vi.mocked(getHistoryList).mockResolvedValue([
      makeRecord(1, "correct", "early morning writing", stored),
    ]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("今天")).toBeInTheDocument();
    });
  });

  it("shows the local calendar date (not UTC-shifted) for records older than 7 days", async () => {
    // 回归（C2）：超过 7 天的记录，裸 new Date() 会把展示日期整体退一天
    // （UTC+8 下本地 10月6日 00:30 的入库串是 "2026-10-05 16:30:00"，
    // 旧实现显示 10月5日）
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0)); // 本地 2026-10-14 12:00
    const stored = new Date(2026, 9, 6, 0, 30).toISOString().replace("T", " ").slice(0, 19);
    vi.mocked(getHistoryList).mockResolvedValue([makeRecord(1, "correct", "old writing", stored)]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("10月6日")).toBeInTheDocument();
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
