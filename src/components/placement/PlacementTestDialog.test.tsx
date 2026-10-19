/**
 * PlacementTestDialog tests（AI 定级测试对话框）。
 *
 * Mock @/lib/db（getDefaultModelCached）、@/lib/db/settings（全局级别 store
 * 的水合/持久化通道 + placement_result）与 @/services/llm。
 * 覆盖：intro→testing→result 阶段推进、phase 切换焦点管理、提交在途
 * 按钮禁用、reset 作废迟到提交（不进入 result）、保存失败可见与重试。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultModelCached } from "@/lib/db";
import { setPlacementResult, setProficiencyLevel } from "@/lib/db/settings";
import { LEVEL_CODES } from "@/lib/levels";
import type { ModelConfig } from "@/types";
import { PlacementTestDialog } from "./PlacementTestDialog";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChat: vi.fn(),
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn(),
}));

// use-proficiency-level 经本模块水合/持久化全局级别；applyResult 的断言落点
vi.mock("@/lib/db/settings", () => ({
  getProficiencyLevel: vi.fn().mockResolvedValue("B1"),
  setProficiencyLevel: vi.fn().mockResolvedValue(undefined),
  getPlacementResult: vi.fn().mockResolvedValue(null),
  setPlacementResult: vi.fn().mockResolvedValue(undefined),
}));

const MODEL: ModelConfig = {
  id: 1,
  name: "test-model",
  api_key: "sk-test-key",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** 单道合法题（4 选项，answer 与选项一致，band 合法） */
function question(band: string, answer = "alpha") {
  return {
    question: `Question for ${band}`,
    options: ["alpha", "beta", "gamma", "delta"],
    answer,
    band,
    focus: "考点",
  };
}

/** 12 道合法题的 JSON 信封（6 档 × 2，档序与 LEVEL_CODES 一致） */
function questionsJson(): string {
  const questions = LEVEL_CODES.flatMap((band) => [question(band), question(band)]);
  return JSON.stringify({ questions });
}

/** 受控 open 的对话框宿主：带 reopen 入口，复刻 LevelCard 的用法 */
function DialogHost() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <PlacementTestDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** 开始测试并等待进入答题阶段 */
async function startTest() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));
  });
  await waitFor(() => {
    expect(screen.getByText("第 1 / 12 题")).toBeInTheDocument();
  });
}

/** 连点「下一题」推进到最后一题（按钮变为「提交」） */
function advanceToLastQuestion() {
  for (let i = 0; i < 11; i++) {
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  }
  expect(screen.getByText("第 12 / 12 题")).toBeInTheDocument();
}

describe("PlacementTestDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDefaultModelCached).mockResolvedValue(MODEL);
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(setPlacementResult).mockResolvedValue(undefined);
  });

  it("opens on the intro phase with the start button", () => {
    render(<DialogHost />);
    expect(
      screen.getByText("通过 12 道递增难度的单选题，估计你的英语水平级别。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始测试" })).toBeInTheDocument();
  });

  // ── 焦点管理（D1-5） ───────────────────────────────────────────

  it("focuses the testing primary button when entering the answering phase", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    render(<DialogHost />);
    await startTest();

    // phase 切换后聚焦主按钮（下一题），键盘用户可直接回车推进
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "下一题" }));
  });

  it("focuses the apply button after submitting and entering the result phase", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    render(<DialogHost />);
    await startTest();
    advanceToLastQuestion();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    });

    expect(screen.getByText(/答对 0 \/ 12 题/)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "应用为当前级别" }));
  });

  it("applies the estimated level and closes when the apply button is clicked", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    render(<DialogHost />);
    await startTest();
    advanceToLastQuestion();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    });

    fireEvent.click(screen.getByRole("button", { name: "应用为当前级别" }));
    // setLevelGlobal → setProficiencyLevel（全局 store write-through）
    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("A2");
    });
  });

  // ── 提交竞态（D1-3） ───────────────────────────────────────────

  it("disables the submit button while the submit is in flight", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());
    // 慢速持久化：提交保持 in-flight
    vi.mocked(setPlacementResult).mockImplementation(() => new Promise(() => {}));

    render(<DialogHost />);
    await startTest();
    advanceToLastQuestion();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    });

    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
  });

  it("never enters the result phase when reset invalidates an in-flight submit", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());
    let resolveSave!: () => void;
    vi.mocked(setPlacementResult).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = () => resolve();
        }),
    );

    render(<DialogHost />);
    await startTest();
    advanceToLastQuestion();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    });
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();

    // 提交在途时关闭对话框：reset 使迟到结果作废
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // 迟到持久化完成：submit 返回 null，不进入 result
    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    expect(screen.queryByText(/答对/)).not.toBeInTheDocument();

    // 重开是一次全新测试：回到 intro
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    expect(screen.getByRole("button", { name: "开始测试" })).toBeInTheDocument();
  });

  // ── 保存失败可见与重试（D1-4） ─────────────────────────────────

  it("shows the save error with a retry button and clears it after a successful retry", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    render(<DialogHost />);
    await startTest();
    advanceToLastQuestion();

    // 持久化失败：结果仍展示，saveError 上屏
    vi.mocked(setPlacementResult).mockRejectedValueOnce(new Error("磁盘写入失败"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    });

    expect(screen.getByText("保存失败：磁盘写入失败")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "重试保存" });
    expect(retryButton).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用为当前级别" })).toBeInTheDocument();

    // 重试成功：saveError 与重试入口消失
    vi.mocked(setPlacementResult).mockResolvedValueOnce(undefined);
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(screen.queryByText("保存失败：磁盘写入失败")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "重试保存" })).not.toBeInTheDocument();
    expect(setPlacementResult).toHaveBeenCalledTimes(2);
  });
});
