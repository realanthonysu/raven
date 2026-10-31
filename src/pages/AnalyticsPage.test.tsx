/**
 * AnalyticsPage component-level tests.
 *
 * Mock useAnalytics hook 与 recharts（jsdom 无法渲染 SVG 图表），
 * 覆盖加载态、空态、统计卡片、时间范围切换与各分区的条件渲染。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsData } from "@/hooks/use-analytics";
import { HISTORY_RESULT_LIMIT } from "@/lib/db/history";
import type { HistoryRecord } from "@/types";
import AnalyticsPage from "./AnalyticsPage";

const mockUseAnalytics = vi.fn();

vi.mock("@/hooks/use-analytics", () => ({
  useAnalytics: (days: number) => mockUseAnalytics(days),
}));

// LevelProgressCard 经 useProficiencyLevel 读取当前级别做文字标注；
// mock 掉全局 store，避免测试触发 DB 水合、保证标注确定
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: "B1", setLevel: () => {} }),
}));

// recharts 在 jsdom 下无法计算尺寸，统一替换为透传容器
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Bar: Stub,
    BarChart: Stub,
    CartesianGrid: Stub,
    Cell: Stub,
    Line: Stub,
    LineChart: Stub,
    Pie: Stub,
    PieChart: Stub,
    PolarAngleAxis: Stub,
    PolarGrid: Stub,
    PolarRadiusAxis: Stub,
    Radar: Stub,
    RadarChart: Stub,
    ResponsiveContainer: Stub,
    Tooltip: Stub,
    XAxis: Stub,
    YAxis: Stub,
  };
});

function makeRecord(id: number, type: HistoryRecord["type"]): HistoryRecord {
  return {
    id,
    type,
    input_text: `text-${id}`,
    result: "",
    graph_data: null,
    created_at: "2026-07-01T10:00:00",
  };
}

/** 构造完整的 AnalyticsData（默认空数据），测试按需覆盖字段 */
function makeAnalyticsData(over: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    loading: false,
    error: null,
    reload: () => {},
    allRecords: [],
    correctRecords: [],
    exerciseRecords: [],
    listeningRecords: [],
    readingRecords: [],
    speakingRecords: [],
    parsed: [],
    totalArticles: 0,
    totalErrors: 0,
    avgErrors: "0",
    uniqueCategories: 0,
    categoryData: [],
    trendData: [],
    improvement: null,
    exerciseTrendData: [],
    listeningTrendData: [],
    speakingTrendData: [],
    capabilityData: [],
    bestDimension: "",
    worstDimension: "",
    recentSessions: [],
    weakCategories: [],
    wrongQuestions: [],
    levelEstimates: [],
    levelSuggestions: [],
    resultsWindowLimited: false,
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalyticsPage />
    </MemoryRouter>,
  );
}

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAnalytics.mockReturnValue(makeAnalyticsData());
  });

  it("shows loading indicator while data is loading", () => {
    mockUseAnalytics.mockReturnValue(makeAnalyticsData({ loading: true }));
    renderPage();

    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("shows empty state when there are no records", () => {
    renderPage();

    expect(screen.getByText("暂无学习数据")).toBeInTheDocument();
  });

  it("renders overview stats when records exist", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "correct"), makeRecord(2, "reading")],
        correctRecords: [makeRecord(1, "correct")],
        readingRecords: [makeRecord(2, "reading")],
        totalErrors: 5,
        avgErrors: "2.5",
        uniqueCategories: 3,
      }),
    );
    renderPage();

    expect(screen.getByText("学习分析")).toBeInTheDocument();
    expect(screen.getByText(/基于 2 条学习记录/)).toBeInTheDocument();
    expect(screen.getByText("总错误数")).toBeInTheDocument();
    expect(screen.getByText("2.5")).toBeInTheDocument();
  });

  it("passes selected time range to useAnalytics", () => {
    mockUseAnalytics.mockReturnValue(makeAnalyticsData({ allRecords: [makeRecord(1, "correct")] }));
    renderPage();

    expect(mockUseAnalytics).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "7天" }));
    expect(mockUseAnalytics).toHaveBeenLastCalledWith(7);
  });

  it("renders capability radar section with best/worst dimensions", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "correct")],
        correctRecords: [makeRecord(1, "correct")],
        capabilityData: [
          { dimension: "语法", score: 30, trend: "declining", color: "#3b82f6" },
          { dimension: "词汇", score: 90, trend: "improving", color: "#f59e0b" },
        ],
        bestDimension: "词汇",
        worstDimension: "语法",
      }),
    );
    renderPage();

    expect(screen.getByText("学习画像")).toBeInTheDocument();
    expect(screen.getByText("最强项：")).toBeInTheDocument();
    expect(screen.getByText("↑ 进步")).toBeInTheDocument();
    expect(screen.getByText("↓ 退步")).toBeInTheDocument();
  });

  it("renders weak category recommendations with mastery info", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "correct")],
        weakCategories: [
          {
            name: "时态错误",
            count: 4,
            mastery: {
              name: "时态错误",
              attempts: 3,
              accuracy: 85,
              recentAccuracy: 90,
              mastered: true,
            },
          },
          { name: "拼写错误", count: 2, mastery: null },
        ],
      }),
    );
    renderPage();

    expect(screen.getByRole("heading", { name: "弱项训练" })).toBeInTheDocument();
    expect(screen.getByText("时态错误")).toBeInTheDocument();
    expect(screen.getByText(/已练 3 次 · 近期正确率 90%/)).toBeInTheDocument();
    expect(screen.getByText("已掌握")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "开始训练" })).toHaveLength(2);
  });

  it("shows a muted note when the detailed-result window is truncated", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "correct")],
        resultsWindowLimited: true,
      }),
    );
    renderPage();

    expect(
      screen.getByText(`趋势与分布统计基于最近 ${HISTORY_RESULT_LIMIT} 条记录的详细结果`),
    ).toBeInTheDocument();
  });

  it("hides the truncation note when the result window is complete", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "correct")],
        resultsWindowLimited: false,
      }),
    );
    renderPage();

    expect(
      screen.queryByText(`趋势与分布统计基于最近 ${HISTORY_RESULT_LIMIT} 条记录的详细结果`),
    ).not.toBeInTheDocument();
  });

  it("renders recent sessions with type-specific score display", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "exercise")],
        recentSessions: [
          {
            id: 1,
            date: "2026/7/1",
            textPreview: "exercise preview",
            type: "exercise",
            score: 8,
            total: 10,
          },
          {
            id: 2,
            date: "2026/7/2",
            textPreview: "speaking preview",
            type: "speaking",
            score: 85,
          },
        ],
      }),
    );
    renderPage();

    expect(screen.getByText("近期记录")).toBeInTheDocument();
    expect(screen.getByText("8/10")).toBeInTheDocument();
    expect(screen.getByText("85分")).toBeInTheDocument();
  });

  it("renders level progress card with skill estimates and suggestions", () => {
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "exercise")],
        levelEstimates: [
          {
            skill: "exercise",
            level: "B2",
            index: 3,
            confidence: "high",
            sampleSize: 9,
            avgScore: 82,
          },
          {
            skill: "listening",
            level: "B1",
            index: 1,
            confidence: "medium",
            sampleSize: 5,
            avgScore: 70,
          },
        ],
        levelSuggestions: [
          {
            kind: "upgrade-global",
            targetLevel: "B1",
            text: "练习、听力已稳定在 B1 档,建议整体升级到 B1",
          },
        ],
      }),
    );
    renderPage();

    expect(screen.getByText("级别进度")).toBeInTheDocument();
    // 当前级别文字标注（含考试锚点）
    expect(screen.getByText(/当前级别 B1（≈高中 · 高考）/)).toBeInTheDocument();
    // 技能明细：样本量 + 均分
    expect(screen.getByText(/9 次练习/)).toBeInTheDocument();
    expect(screen.getByText(/均分 82/)).toBeInTheDocument();
    expect(screen.getByText(/置信度 高/)).toBeInTheDocument();
    // 无估计的技能标注样本不足（写作/阅读/口语）
    expect(screen.getAllByText("样本不足").length).toBeGreaterThan(0);
    // 建议文案 + 目标徽章
    expect(screen.getByText("练习、听力已稳定在 B1 档,建议整体升级到 B1")).toBeInTheDocument();
  });

  it("shows level progress guidance empty state when there are no estimates", () => {
    mockUseAnalytics.mockReturnValue(makeAnalyticsData({ allRecords: [makeRecord(1, "correct")] }));
    renderPage();

    expect(
      screen.getByText("完成几次练习后，这里会基于你的表现估计各技能级别"),
    ).toBeInTheDocument();
  });

  it("renders and expands the wrong-question panel without re-reading analytics state", () => {
    // H-03：错题本"展开更多"状态封装在 memo 面板内部，展开不会让页面重新
    // 请求 analytics 数据（days 仍为 0，useAnalytics 调用次数不变）
    const wrongQuestions = Array.from({ length: 7 }, (_, i) => ({
      historyId: 100 + i,
      category: "时态错误",
      createdAt: "2026-07-01T10:00:00",
      question: {
        type: "fill" as const,
        question: `Wrong question ${i}`,
        options: ["a", "b"],
        answer: "a",
        explanation: "e",
      },
      userAnswer: "b",
    }));
    mockUseAnalytics.mockReturnValue(
      makeAnalyticsData({
        allRecords: [makeRecord(1, "exercise")],
        wrongQuestions,
      }),
    );
    renderPage();

    expect(screen.getByText("错题本")).toBeInTheDocument();
    expect(screen.getByText("Wrong question 0")).toBeInTheDocument();
    expect(screen.queryByText("Wrong question 5")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /展开更多（剩余 2 道）/ }));

    expect(screen.getByText("Wrong question 5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /展开更多/ })).not.toBeInTheDocument();
    expect(mockUseAnalytics).toHaveBeenLastCalledWith(0);
  });
});
