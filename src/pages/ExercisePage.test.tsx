import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockStreamChat } from "@/test/mocks";
import { createMockStreamChat, sampleFillExercises } from "@/test/mocks";
import ExercisePage from "./ExercisePage";

// ─── Module mocks ─────────────────────────────────────────────────

let mockStreamChat: MockStreamChat;

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => mockStreamChat,
}));

vi.mock("@/lib/db", () => ({
  addHistorySafe: vi.fn().mockResolvedValue(1),
  recordLearningActivity: vi.fn().mockResolvedValue(undefined),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

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

/**
 * Mock execute to call onDone with the given text after a microtask.
 * This simulates the real async behavior of the LLM streaming.
 */
function mockExecuteWithResult(fullText: string) {
  mockStreamChat.execute = vi
    .fn()
    .mockImplementation(
      (
        _prompt: string,
        _user: string,
        overrides: { onDone?: (text: string) => void; onError?: (err: Error) => void },
      ) => {
        setTimeout(() => overrides.onDone?.(fullText), 0);
        return Promise.resolve();
      },
    );
}

function mockExecuteWithError(err: Error) {
  mockStreamChat.execute = vi
    .fn()
    .mockImplementation(
      (_prompt: string, _user: string, overrides: { onError?: (err: Error) => void }) => {
        setTimeout(() => overrides.onError?.(err), 0);
        return Promise.resolve();
      },
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
    mockExecuteWithResult(JSON.stringify({ exercises: sampleFillExercises }));

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
    mockExecuteWithResult("not valid json at all");

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/解析练习题失败/)).toBeInTheDocument();
    });
  });

  it("shows error when LLM request fails", async () => {
    mockExecuteWithError(new Error("network timeout"));

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
    mockExecuteWithResult(JSON.stringify({ exercises: sampleFillExercises }));

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
    mockExecuteWithResult(JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage("主谓一致");

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    // The system prompt should contain the category name
    const promptArg = mockStreamChat.execute.mock.calls[0][0] as string;
    expect(promptArg).toContain("主谓一致");
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
    mockExecuteWithResult(JSON.stringify({ exercises: sampleFillExercises }));

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Submit button should be disabled initially (no answers filled)
    const submitButton = screen.getByText(/提交答案/).closest("button");
    expect(submitButton).toBeDisabled();
  });
});
