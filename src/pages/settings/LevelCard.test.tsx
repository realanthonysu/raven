import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLevelGlobal } from "@/hooks/use-proficiency-level";
import { LevelCard } from "./LevelCard";

vi.mock("@/lib/db/settings", () => ({
  getProficiencyLevel: vi.fn().mockResolvedValue("B1"),
  setProficiencyLevel: vi.fn().mockResolvedValue(undefined),
  getPlacementResult: vi.fn().mockResolvedValue(null),
  setPlacementResult: vi.fn().mockResolvedValue(undefined),
}));

const mockGetHistoryWithResults = vi.fn();
// useLevelEstimation 经 @/lib/db barrel 拉取历史做被动估计；
// 部分 mock：仅替换 getHistoryWithResults，parseDbTimestamp 等走真实实现
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getHistoryWithResults: (...args: unknown[]) => mockGetHistoryWithResults(...args),
}));

import { getPlacementResult, getProficiencyLevel, setProficiencyLevel } from "@/lib/db/settings";

describe("LevelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProficiencyLevel).mockResolvedValue("B1");
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(getPlacementResult).mockResolvedValue(null);
    mockGetHistoryWithResults.mockResolvedValue({ records: [], resultById: new Map() });
  });

  afterEach(() => {
    // 全局级别 store 是模块级共享状态：用例改写后复位，避免污染其他用例
    setLevelGlobal("B1");
  });

  it("reflects the level stored in settings on mount", async () => {
    // 首个渲染触发 store 水合（模块级仅一次），读取 DB 中的级别
    vi.mocked(getProficiencyLevel).mockResolvedValue("B2+");
    render(<LevelCard />);
    await waitFor(() => {
      expect(screen.getByText("B2+（≈专业四级 TEM-4）")).toBeInTheDocument();
    });
  });

  it("renders the title, the CEFR + anchor explanation and the current level", () => {
    render(<LevelCard />);
    expect(screen.getByText("英语水平定级")).toBeInTheDocument();
    expect(screen.getByText(/CEFR 国际标准（A2–C1）并以中国考试锚点双标注/)).toBeInTheDocument();
    expect(screen.getByText("当前级别")).toBeInTheDocument();
    expect(screen.getByText("B1（≈高中 · 高考）")).toBeInTheDocument();
  });

  it("lists all self-report survey options", () => {
    render(<LevelCard />);
    expect(screen.getByText("小学及以下")).toBeInTheDocument();
    expect(screen.getByText("初中（中考）")).toBeInTheDocument();
    expect(screen.getByText("高中（高考）")).toBeInTheDocument();
    expect(screen.getByText("大学四级")).toBeInTheDocument();
    expect(screen.getByText("大学六级")).toBeInTheDocument();
    expect(screen.getByText("专业四级")).toBeInTheDocument();
    expect(screen.getByText("专业八级 / 雅思·托福")).toBeInTheDocument();
  });

  it("persists the selected level and updates the badge", async () => {
    render(<LevelCard />);
    fireEvent.click(screen.getByText("大学六级"));

    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("B2");
    });
    // 徽章即时更新为对应 CEFR 级别标签
    expect(screen.getByText("B2（≈大学六级 CET-6）")).toBeInTheDocument();
  });

  it("maps exam-based options to the same CEFR code", async () => {
    render(<LevelCard />);
    // 小学及以下 与 初中（中考）同属 A2
    fireEvent.click(screen.getByText("初中（中考）"));

    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("A2");
    });
    expect(screen.getByText("A2（≈小学/初中 · 中考）")).toBeInTheDocument();
  });

  it("shows a loading hint while passive estimation loads", () => {
    // 永不 resolve：loading 保持 true
    mockGetHistoryWithResults.mockReturnValue(new Promise(() => {}));
    render(<LevelCard />);

    expect(screen.getByText("被动估计")).toBeInTheDocument();
    expect(screen.getByText("正在估计…")).toBeInTheDocument();
  });

  it("shows an insufficient-data note when there are no estimates", async () => {
    // beforeEach 默认 resolve 空数据 → 无估计
    render(<LevelCard />);

    await waitFor(() => {
      expect(screen.getByText("练习数据不足，暂无法估计级别。")).toBeInTheDocument();
    });
  });

  it("renders passive estimation badges and applies an upgrade suggestion", async () => {
    // 4 次练习，难度 B2，满分 → 练习估计 B2+（置信度 medium），
    // 触发 upgrade-skill(目标 B2+) 与 practice(目标 B1+) 两条建议
    const records = [1, 2, 3, 4].map((id) => ({
      id,
      type: "exercise" as const,
      input_text: "t",
      result: "",
      graph_data: null,
      difficulty_level: "B2",
      created_at: `2026-07-0${id}T10:00:00`,
    }));
    const pairs: Array<[number, string]> = records.map((r) => [
      r.id,
      JSON.stringify({
        category: "时态错误",
        exercises: Array.from({ length: 5 }, (_, i) => ({
          type: "fill",
          question: `q${i}`,
          answer: "a",
          explanation: "e",
        })),
        userAnswers: Array.from({ length: 5 }, () => "a"),
        score: 5,
      }),
    ]);
    mockGetHistoryWithResults.mockResolvedValue({ records, resultById: new Map(pairs) });

    render(<LevelCard />);

    expect(screen.getByText("被动估计")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/练习已在 B2\+ 档稳定表现/)).toBeInTheDocument();
    });
    // 练习技能的估计徽章
    expect(screen.getByText("B2+")).toBeInTheDocument();

    // 点击第一条建议的"应用" → setLevel(B2+) 并 refresh
    fireEvent.click(screen.getAllByText("应用")[0]);
    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("B2+");
    });
  });
});

// ── AI 定级测试（Track A）─────────────────────────────────────────

describe("LevelCard · AI 定级测试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProficiencyLevel).mockResolvedValue("B1");
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(getPlacementResult).mockResolvedValue(null);
    mockGetHistoryWithResults.mockResolvedValue({ records: [], resultById: new Map() });
  });

  it("opens the placement test dialog from the entry button", () => {
    render(<LevelCard />);
    // 区段标题与对话框标题同名，按 button 角色精确定位入口
    fireEvent.click(screen.getByRole("button", { name: /AI 定级测试/ }));

    // intro 阶段：测试形式说明 + 开始测试按钮
    expect(
      screen.getByText("通过 12 道递增难度的单选题，估计你的英语水平级别。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始测试" })).toBeInTheDocument();
  });

  it("hides the last-result row when there is no placement record", async () => {
    render(<LevelCard />);

    await waitFor(() => {
      expect(getPlacementResult).toHaveBeenCalled();
    });
    expect(screen.queryByText(/上次测试/)).not.toBeInTheDocument();
  });

  it("renders the last placement result row when a record exists", async () => {
    vi.mocked(getPlacementResult).mockResolvedValue({
      tested_at: "2026-10-19T12:00:00.000Z",
      estimated_level: "B2",
      // 各档正确率（0-1 小数）；6 档题数均衡时 Σ(正确率 × 2) = 9
      per_band: { A2: 1, B1: 1, "B1+": 1, B2: 1, "B2+": 0.5, C1: 0 },
      question_count: 12,
    });
    render(<LevelCard />);

    await waitFor(() => {
      expect(
        screen.getByText(/上次测试：B2（≈大学六级 CET-6） · 10-19 · 答对 9\/12/),
      ).toBeInTheDocument();
    });
  });
});
