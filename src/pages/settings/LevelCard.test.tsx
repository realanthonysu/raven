import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLevelGlobal } from "@/hooks/use-proficiency-level";
import { HISTORY_RESULT_LIMIT } from "@/lib/db";
import type { LevelUpSuggestion, SkillEstimate } from "@/lib/level-estimation";
import { LevelCard } from "./LevelCard";

vi.mock("@/lib/db/settings", () => ({
  getProficiencyLevel: vi.fn().mockResolvedValue("B1"),
  setProficiencyLevel: vi.fn().mockResolvedValue(undefined),
  getPlacementResult: vi.fn().mockResolvedValue(null),
  setPlacementResult: vi.fn().mockResolvedValue(undefined),
}));

// 被动估计 hook 直接 mock：组件测试聚焦渲染分支（错误态/重试/截断披露），
// hook 自身的数据加载、归一化与 fail-soft 语义由 use-level-estimation.test.ts 覆盖
const mockUseLevelEstimation = vi.fn();
vi.mock("@/hooks/use-level-estimation", () => ({
  useLevelEstimation: () => mockUseLevelEstimation(),
}));

import { getPlacementResult, getProficiencyLevel, setProficiencyLevel } from "@/lib/db/settings";

/** useLevelEstimation 的返回视图（含 f5 的 error 与 f6 的 resultsWindowLimited） */
interface EstimationView {
  estimates: SkillEstimate[];
  suggestions: LevelUpSuggestion[];
  loading: boolean;
  error: string | null;
  resultsWindowLimited: boolean;
  refresh: () => void;
}

/** 按需装配 hook 返回值：默认空态（无估计/无错误/无截断）；refresh 由本 helper 创建并回传 */
function mockEstimation(over: Partial<Omit<EstimationView, "refresh">> = {}) {
  const refresh = vi.fn();
  const view: EstimationView = {
    estimates: [],
    suggestions: [],
    loading: false,
    error: null,
    resultsWindowLimited: false,
    ...over,
    refresh,
  };
  mockUseLevelEstimation.mockReturnValue(view);
  return { refresh };
}

describe("LevelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProficiencyLevel).mockResolvedValue("B1");
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(getPlacementResult).mockResolvedValue(null);
    mockEstimation();
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
    mockEstimation({ loading: true });
    render(<LevelCard />);

    expect(screen.getByText("被动估计")).toBeInTheDocument();
    expect(screen.getByText("正在估计…")).toBeInTheDocument();
  });

  it("shows an insufficient-data note when there are no estimates", () => {
    // 默认空态：无错误、无估计
    render(<LevelCard />);

    expect(screen.getByText("练习数据不足，暂无法估计级别。")).toBeInTheDocument();
  });

  it("shows an error banner with retry when estimation fails to load", () => {
    // f5：加载失败不得伪装成"数据不足"——错误横幅 + 重试入口，且优先于空态文案
    const { refresh } = mockEstimation({ error: "级别估计加载失败" });
    render(<LevelCard />);

    expect(screen.getByText("级别估计加载失败")).toBeInTheDocument();
    expect(screen.queryByText("练习数据不足，暂无法估计级别。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("discloses the result window when estimation is truncated", () => {
    // f6：重型 result 窗口被 HISTORY_RESULT_LIMIT 截断时透明化口径
    mockEstimation({ resultsWindowLimited: true });
    render(<LevelCard />);

    expect(
      screen.getByText(`级别估计基于最近 ${HISTORY_RESULT_LIMIT} 条记录的详细结果`),
    ).toBeInTheDocument();
  });

  it("renders passive estimation badges and applies an upgrade suggestion", async () => {
    // 练习估计 B2+（置信度 medium）→ upgrade-skill(目标 B2+) 建议
    const { refresh } = mockEstimation({
      estimates: [
        {
          skill: "exercise",
          level: "B2+",
          index: 4,
          confidence: "medium",
          sampleSize: 4,
          avgScore: 100,
        },
      ],
      suggestions: [
        {
          kind: "upgrade-skill",
          skill: "exercise",
          targetLevel: "B2+",
          text: "练习已在 B2+ 档稳定表现,建议升级",
        },
      ],
    });

    render(<LevelCard />);

    expect(screen.getByText("被动估计")).toBeInTheDocument();
    expect(screen.getByText(/练习已在 B2\+ 档稳定表现/)).toBeInTheDocument();
    // 练习技能的估计徽章
    expect(screen.getByText("B2+")).toBeInTheDocument();

    // 点击第一条建议的"应用" → setLevel(B2+) 并 refresh（刷新样本基数）
    fireEvent.click(screen.getAllByText("应用")[0]);
    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("B2+");
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("renders the practice suggestion as text only (no apply button)", () => {
    // upgrade-skill(目标 B2+) + practice(目标 B1+) 两条建议；practice 的目标是
    // 练习难度而非全局级别，不得提供「应用」按钮
    mockEstimation({
      estimates: [
        {
          skill: "exercise",
          level: "B2+",
          index: 4,
          confidence: "medium",
          sampleSize: 4,
          avgScore: 100,
        },
      ],
      suggestions: [
        {
          kind: "upgrade-skill",
          skill: "exercise",
          targetLevel: "B2+",
          text: "练习已在 B2+ 档稳定表现,建议升级",
        },
        {
          kind: "practice",
          skill: "exercise",
          targetLevel: "B1+",
          text: "循序渐进:建议下次练习选「挑战」档(B1+)",
        },
      ],
    });

    render(<LevelCard />);

    expect(screen.getByText(/练习已在 B2\+ 档稳定表现/)).toBeInTheDocument();
    // practice 文案在（仅提示）；f16：exercise 技能的 practice 文案不得叠字
    // （旧文案「建议练习练习选择」系模板与 SKILL_LABELS 重复拼接所致）
    expect(screen.getByText(/循序渐进:建议下次练习选「挑战」档/)).toBeInTheDocument();
    // 仅 upgrade-skill 一条带「应用」按钮，practice 行无按钮
    expect(screen.getAllByRole("button", { name: "应用" })).toHaveLength(1);
  });
});

// ── AI 定级测试（Track A）─────────────────────────────────────────

describe("LevelCard · AI 定级测试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProficiencyLevel).mockResolvedValue("B1");
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(getPlacementResult).mockResolvedValue(null);
    mockEstimation();
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
