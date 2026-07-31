/**
 * AnalyticsPage component-level tests.
 *
 * Mock useAnalytics hook 与 recharts（jsdom 无法渲染 SVG 图表），
 * 覆盖加载态、空态、统计卡片、时间范围切换与各分区的条件渲染。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsData } from "@/hooks/use-analytics";
import type { HistoryRecord } from "@/types";
import AnalyticsPage from "./AnalyticsPage";

const mockUseAnalytics = vi.fn();

vi.mock("@/hooks/use-analytics", () => ({
  useAnalytics: (days: number) => mockUseAnalytics(days),
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
});
