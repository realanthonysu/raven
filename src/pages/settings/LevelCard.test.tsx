import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLevelGlobal } from "@/hooks/use-proficiency-level";
import { LevelCard } from "./LevelCard";

vi.mock("@/lib/db/settings", () => ({
  getProficiencyLevel: vi.fn().mockResolvedValue("B1"),
  setProficiencyLevel: vi.fn().mockResolvedValue(undefined),
}));

import { getProficiencyLevel, setProficiencyLevel } from "@/lib/db/settings";

describe("LevelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProficiencyLevel).mockResolvedValue("B1");
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
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
});
