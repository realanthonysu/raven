import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockStreamChat } from "@/test/mocks";
import {
  createMockStreamChat,
  mockExecuteWithError,
  mockExecuteWithResult,
  sampleFillExercises,
} from "@/test/mocks";
import ExercisePage from "./ExercisePage";

// ─── Module mocks ─────────────────────────────────────────────────

let mockStreamChat: MockStreamChat;

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => mockStreamChat,
}));

// DB 层部分 mock：写路径替换为 vi.fn()，读路径（getProficiencyLevel）经 barrel
// 走真实 settings 模块——测试环境 invoke 不可用，fail-soft 回落 DEFAULT_LEVEL(B1)
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  addHistorySafe: vi.fn().mockResolvedValue(42),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

// useLLMStreamPage 的 persistStream 刻意从子模块导入会抛错的 addHistory
// （不经 barrel，以便区分"写库失败"与"跳过写库"），此处按同一路径 mock，
// 保持"保存成功"的既有行为
vi.mock("@/lib/db/history", () => ({
  addHistory: vi.fn().mockResolvedValue({ lastInsertId: 42 }),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

import { addHistory } from "@/lib/db/history";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Renders ExercisePage inside a proper Route so useParams works.
 * The route path "exercise/:category" matches the URL structure in App.tsx.
 */
function renderExercisePage(category = "时态错误") {
  return render(
    <MemoryRouter initialEntries={[`/exercise/${encodeURIComponent(category)}`]}>
      <Routes>
        <Route path="exercise/:category" element={<ExercisePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ExercisePage", () => {
  beforeEach(() => {
    mockStreamChat = createMockStreamChat();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders loading state with category name", () => {
    renderExercisePage("时态错误");

    expect(screen.getByText(/弱项训练/)).toBeInTheDocument();
    expect(screen.getByText(/时态错误/)).toBeInTheDocument();
    expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();
  });

  it("shows 'back to analytics' navigation in loading phase", () => {
    renderExercisePage();

    expect(screen.getByText(/返回/)).toBeInTheDocument();
  });

  it("shows retry hint after 30 seconds timeout", () => {
    renderExercisePage();

    // Retry hint should not be visible initially
    expect(screen.queryByText(/生成时间较长/)).not.toBeInTheDocument();

    // Advance timers past 30 seconds — wrap in act so React processes the state update
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(screen.getByText(/生成时间较长/)).toBeInTheDocument();
  });

  it("transitions to answering phase when exercises are generated", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage();

    // Wait for the transition to answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Exercise questions should be visible
    expect(screen.getByText(/She ___ \(go\) to school/)).toBeInTheDocument();
    expect(screen.getByText(/They ___ \(be\) happy/)).toBeInTheDocument();
  });

  it("shows error when LLM returns unparseable content", async () => {
    mockExecuteWithResult(mockStreamChat, "not valid json at all");

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/解析练习题失败/)).toBeInTheDocument();
    });
  });

  it("shows error when LLM request fails", async () => {
    mockExecuteWithError(mockStreamChat, new Error("network timeout"));

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
      expect(screen.getByText(/network timeout/)).toBeInTheDocument();
    });
  });

  it("renders category name decoded from URL-encoded Chinese characters", () => {
    renderExercisePage("句式杂糅");

    expect(screen.getByText(/弱项训练/)).toBeInTheDocument();
    expect(screen.getByText(/句式杂糅/)).toBeInTheDocument();
  });

  it("displays score after submitting answers in review phase", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage();

    // Wait for answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Select the correct answer for the first question (click the "goes" option)
    const goesButton = screen.getByRole("button", { name: "goes" });
    fireEvent.click(goesButton);

    // Submit
    const submitButton = screen.getByText(/提交答案/);
    fireEvent.click(submitButton);

    // Should transition to review phase with score
    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });

    // Should show "再来一轮" button
    expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
    expect(screen.getByText(/返回学习分析/)).toBeInTheDocument();
  });

  it("calls execute with the correct category in the prompt", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage("主谓一致");

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    // The system prompt should contain the category name
    const promptArg = mockStreamChat.execute.mock.calls[0][0] as string;
    expect(promptArg).toContain("主谓一致");
  });

  // ── 英语水平级别（Track 1） ──

  it("shows the current proficiency level badge in the header", () => {
    renderExercisePage("主谓一致");

    // 测试环境 settings 读取失败 → 回退默认级别 B1
    expect(screen.getByText("B1（≈高中 · 高考）")).toBeInTheDocument();
  });

  it("injects the level spec block into the generation prompt", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage("主谓一致");

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    const promptArg = mockStreamChat.execute.mock.calls[0][0] as string;
    // buildExercisePrompt(category, ctx, 5, "B1")：难度规格块 + 规格内由易到难
    expect(promptArg).toContain("【难度规格 · CEFR B1，≈高中 · 高考】");
    expect(promptArg).toContain("5 道题在上述难度规格内由易到难排列");
    expect(promptArg).not.toContain("难度递进，从简单到中等");
  });

  it("persists the generation level as history difficulty_level", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage("主谓一致");

    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // 作答并提交 → persistResult → addHistory（hook 合并 getDifficultyLevel）
    fireEvent.click(screen.getByRole("button", { name: "goes" }));
    fireEvent.click(screen.getByText(/提交答案/));

    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });

    expect(addHistory).toHaveBeenCalledWith(
      expect.objectContaining({ type: "exercise", difficulty_level: "B1" }),
    );
  });

  it("handleRetry returns to loading and regenerates exercises", async () => {
    const exercisesJson = JSON.stringify({ exercises: sampleFillExercises });

    mockStreamChat.execute = vi
      .fn()
      .mockImplementation(
        (_prompt: string, _user: string, overrides: { onDone?: (text: string) => void }) => {
          setTimeout(() => overrides.onDone?.(exercisesJson), 0);
          return Promise.resolve();
        },
      );

    renderExercisePage();

    // Wait for answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Answer and submit to reach review phase
    const goesButton = screen.getByRole("button", { name: "goes" });
    fireEvent.click(goesButton);
    fireEvent.click(screen.getByText(/提交答案/));

    await waitFor(() => {
      expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
    });

    // Click "再来一轮"
    fireEvent.click(screen.getByText(/再来一轮/));

    // Should go back to loading phase
    await waitFor(() => {
      expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();
    });

    // execute should have been called again
    expect(mockStreamChat.execute).toHaveBeenCalledTimes(2);
  });

  it("disables submit when no answers are provided", async () => {
    mockExecuteWithResult(mockStreamChat, JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Submit button should be disabled initially (no answers filled)
    const submitButton = screen.getByText(/提交答案/).closest("button");
    expect(submitButton).toBeDisabled();
  });

  it("clears the stale error banner when retrying after a loading-phase failure", async () => {
    // B2 回归：失败态停留在 loading 时 transition("loading") 同阶段早退，
    // onEnter 的 RESET 不会触发——重试必须显式清错误槽。
    // 单一 mock 按调用次序分发：首次失败、其后成功（渲染前装好，避免
    // 中途替换 execute 造成闭包捕获旧实现的假象）。
    const exercisesJson = JSON.stringify({ exercises: sampleFillExercises });
    let executeCall = 0;
    mockStreamChat.execute = vi
      .fn()
      .mockImplementation(
        (
          _prompt: string,
          _user: string,
          overrides: { onDone?: (text: string) => void; onError?: (err: Error) => void },
        ) => {
          executeCall += 1;
          if (executeCall === 1) {
            setTimeout(() => overrides.onError?.(new Error("network timeout")), 0);
          } else {
            setTimeout(() => overrides.onDone?.(exercisesJson), 0);
          }
          return Promise.resolve();
        },
      );

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
      expect(screen.getByText(/network timeout/)).toBeInTheDocument();
    });

    // 点击重新生成：旧错误横幅清空，显示 loading
    fireEvent.click(screen.getByText(/重新生成/));
    await waitFor(() => {
      expect(screen.queryByText(/network timeout/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();

    // 成功后进入答题阶段，无旧错误残留
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/生成失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/network timeout/)).not.toBeInTheDocument();
  });
});
