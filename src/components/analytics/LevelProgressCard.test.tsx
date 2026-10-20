/**
 * LevelProgressCard component tests.
 *
 * Mock recharts（jsdom 无法渲染 SVG 图表）与 useProficiencyLevel（固定当前级别），
 * 覆盖空态、技能明细（置信度/样本量/均分/样本不足）、建议列表与窗口说明。
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  LEVEL_ESTIMATE_RESULT_LIMIT,
  type LevelUpSuggestion,
  type SkillEstimate,
} from "@/lib/level-estimation";
import { LevelProgressCard } from "./LevelProgressCard";

// recharts 在 jsdom 下无法计算尺寸，统一替换为透传容器
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    PolarAngleAxis: Stub,
    PolarGrid: Stub,
    PolarRadiusAxis: Stub,
    Radar: Stub,
    RadarChart: Stub,
    ResponsiveContainer: Stub,
    Tooltip: Stub,
  };
});

// 固定当前级别，保证"当前级别"标注确定
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: "B2", setLevel: vi.fn() }),
}));

const estimates: SkillEstimate[] = [
  { skill: "exercise", level: "B2", index: 3, confidence: "high", sampleSize: 9, avgScore: 82 },
  { skill: "listening", level: "B1", index: 1, confidence: "medium", sampleSize: 5, avgScore: 70 },
  { skill: "reading", level: "B2+", index: 4, confidence: "low", sampleSize: 3, avgScore: null },
];

const suggestions: LevelUpSuggestion[] = [
  { kind: "upgrade-global", targetLevel: "B2", text: "练习、听力已稳定在 B2 档,建议整体升级到 B2" },
  {
    kind: "practice",
    skill: "exercise",
    targetLevel: "B2",
    text: "循序渐进:建议下次练习选「挑战」档(B2)",
  },
  {
    kind: "downgrade-hint",
    targetLevel: "B1",
    text: "近期表现明显低于当前级别,建议降一档到 B1 巩固基础",
  },
];

describe("LevelProgressCard", () => {
  it("shows a guidance empty state when there are no estimates", () => {
    render(<LevelProgressCard estimates={[]} suggestions={[]} />);
    expect(
      screen.getByText("完成几次练习后，这里会基于你的表现估计各技能级别"),
    ).toBeInTheDocument();
    // 无雷达/明细
    expect(screen.queryByText("升级建议")).not.toBeInTheDocument();
  });

  it("renders the current-level annotation and skill detail rows", () => {
    render(<LevelProgressCard estimates={estimates} suggestions={[]} />);

    expect(screen.getByText("级别进度")).toBeInTheDocument();
    expect(screen.getByText(/当前级别 B2（≈大学六级 CET-6）/)).toBeInTheDocument();
    // 计分技能：样本量 + 均分 + 置信度
    expect(screen.getByText(/9 次练习 · 均分 82/)).toBeInTheDocument();
    expect(screen.getByText(/置信度 高/)).toBeInTheDocument();
    expect(screen.getByText(/置信度 中/)).toBeInTheDocument();
    // 阅读：无得分，仅样本量
    expect(screen.getByText("3 次阅读")).toBeInTheDocument();
    expect(screen.getByText(/置信度 低/)).toBeInTheDocument();
    // 无估计的技能（写作/口语）标注样本不足
    expect(screen.getAllByText("样本不足")).toHaveLength(2);
  });

  it("renders the suggestion list with target badges", () => {
    render(<LevelProgressCard estimates={estimates} suggestions={suggestions} />);

    expect(screen.getByText("练习、听力已稳定在 B2 档,建议整体升级到 B2")).toBeInTheDocument();
    // 夹具须与 buildSuggestions 引擎真实产出一致（f16：exercise 技能为
    // 「建议下次练习选」，而非旧模板的叠字「建议练习练习选择」）
    expect(screen.getByText("循序渐进:建议下次练习选「挑战」档(B2)")).toBeInTheDocument();
    expect(
      screen.getByText("近期表现明显低于当前级别,建议降一档到 B1 巩固基础"),
    ).toBeInTheDocument();
    // 目标级别徽章（B2 出现多次：练习徽章 + 两条建议徽章；B1：听力徽章 + 降档建议徽章）
    expect(screen.getAllByText("B2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("B1").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the result-window note only when the window is truncated", () => {
    const note = `级别估计基于最近 ${LEVEL_ESTIMATE_RESULT_LIMIT} 条记录的详细结果`;
    const { rerender } = render(
      <LevelProgressCard estimates={estimates} suggestions={[]} resultsWindowLimited />,
    );
    expect(screen.getByText(note)).toBeInTheDocument();

    rerender(
      <LevelProgressCard estimates={estimates} suggestions={[]} resultsWindowLimited={false} />,
    );
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });
});
