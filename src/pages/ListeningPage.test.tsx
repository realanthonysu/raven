/**
 * ListeningPage component-level tests.
 *
 * Strategy: mock use-stream-chat so useLLMStreamPage gets the mock execute,
 * mock useAudioPlayer to avoid Tauri TTS plugin dependency.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockStreamChat } from "@/test/mocks";
import { createMockStreamChat, mockExecuteWithError, mockExecuteWithResult } from "@/test/mocks";
import ListeningPage from "./ListeningPage";

// ─── Module mocks ─────────────────────────────────────────────────

let mockStreamChat: MockStreamChat;

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => mockStreamChat,
}));

vi.mock("@/lib/db", () => ({
  addHistorySafe: vi.fn().mockResolvedValue(42),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@/hooks/use-audio-player", () => ({
  useAudioPlayer: () => ({
    playing: false,
    loading: false,
    play: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  }),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const sentencesJson = JSON.stringify({
  sentences: [
    { text: "The quick brown fox jumps", hint: "快速的棕色狐狸跳" },
    { text: "She sells seashells", hint: "她卖贝壳" },
    { text: "How are you doing today", hint: "你今天怎么样" },
    { text: "The weather is beautiful", hint: "天气很好" },
    { text: "I love learning English", hint: "我喜欢学英语" },
  ],
});

// ─── Helpers ──────────────────────────────────────────────────────

function renderListeningPage() {
  return render(
    <MemoryRouter initialEntries={["/listening"]}>
      <ListeningPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ListeningPage", () => {
  beforeEach(() => {
    mockStreamChat = createMockStreamChat();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Idle phase ──

  it("renders idle phase with title and description", () => {
    renderListeningPage();
    expect(screen.getByText(/Listening Copilot/)).toBeInTheDocument();
    expect(screen.getByText(/听 TTS 播放的英文句子/)).toBeInTheDocument();
  });

  it("shows difficulty and topic selectors", () => {
    renderListeningPage();
    expect(screen.getByRole("button", { name: "初级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日常对话" })).toBeInTheDocument();
  });

  it("shows start practice button", () => {
    renderListeningPage();
    expect(screen.getByText(/开始练习/)).toBeInTheDocument();
  });

  // ── Loading → listening transition ──

  it("transitions to listening phase when sentences are generated", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/点击播放/)).toBeInTheDocument();
    });

    // Should show textarea for dictation
    expect(screen.getByPlaceholderText(/输入你听到的句子/)).toBeInTheDocument();
    // Should show progress
    expect(screen.getByText(/1 \/ 5/)).toBeInTheDocument();
  });

  it("shows error when LLM request fails", async () => {
    mockExecuteWithError(mockStreamChat, new Error("服务不可用"));
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/服务不可用/)).toBeInTheDocument();
    });
  });

  it("shows error when LLM returns unparseable content", async () => {
    mockExecuteWithResult(mockStreamChat, "not valid json at all");
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
    });
  });

  it("shows retry button after error", async () => {
    mockExecuteWithError(mockStreamChat, new Error("timeout"));
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/重试/)).toBeInTheDocument();
    });
  });

  it("returns to idle when retry button clicked", async () => {
    mockExecuteWithError(mockStreamChat, new Error("timeout"));
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/重试/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/重试/));

    expect(screen.getByText(/开始练习/)).toBeInTheDocument();
  });

  // ── Listening phase ──

  it("allows typing in the textarea during listening phase", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/输入你听到的句子/)).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(/输入你听到的句子/);
    fireEvent.change(textarea, { target: { value: "The quick brown fox" } });
    expect(textarea).toHaveValue("The quick brown fox");
  });

  it("navigates to next sentence when next button clicked", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/下一句/));
    expect(screen.getByText(/2 \/ 5/)).toBeInTheDocument();
  });

  it("disables previous button on first sentence", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/上一句/)).toBeInTheDocument();
    });

    const prevBtn = screen.getByText(/上一句/).closest("button");
    if (!prevBtn) throw new Error("prev button not found");
    expect(prevBtn).toBeDisabled();
  });

  it("shows submit button on last sentence", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    // Navigate to last sentence
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }

    expect(screen.getByText(/提交/)).toBeInTheDocument();
  });

  it("shows and hides hint on toggle", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/查看中文提示/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/查看中文提示/));
    expect(screen.getByText("快速的棕色狐狸跳")).toBeInTheDocument();
    expect(screen.getByText(/隐藏提示/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/隐藏提示/));
    expect(screen.queryByText("快速的棕色狐狸跳")).not.toBeInTheDocument();
  });

  // ── Review phase ──

  it("transitions to review phase after submitting", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    // Navigate to last sentence
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }

    fireEvent.click(screen.getByText(/提交/));

    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });

    // Should show "再来一轮" button
    expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
  });

  it("shows correct/wrong indicators in review phase", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/输入你听到的句子/)).toBeInTheDocument();
    });

    // Type correct answer for first sentence
    fireEvent.change(screen.getByPlaceholderText(/输入你听到的句子/), {
      target: { value: "The quick brown fox jumps" },
    });

    // Navigate to last and submit
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }
    fireEvent.click(screen.getByText(/提交/));

    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });
  });

  // ── Prompt content ──

  it("calls execute with listening prompt containing difficulty", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    const systemPrompt = mockStreamChat.execute.mock.calls[0][0] as string;
    expect(systemPrompt).toContain("初级");
    expect(systemPrompt).toContain("日常对话");
  });

  // ── Retry hint ──

  it("shows retry hint after30 seconds", () => {
    renderListeningPage();
    fireEvent.click(screen.getByText(/开始练习/));

    expect(screen.queryByText(/生成时间较长/)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(screen.getByText(/生成时间较长/)).toBeInTheDocument();
  });
});
