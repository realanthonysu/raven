/**
 * ListeningPage component-level tests.
 *
 * Strategy: mock use-stream-chat so useLLMStreamPage gets the mock execute,
 * mock useAudioPlayer to avoid Tauri TTS plugin dependency.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockStreamChat } from "@/test/mocks";
import { createMockStreamChat, mockExecuteWithError, mockExecuteWithResult } from "@/test/mocks";
import ListeningPage from "./ListeningPage";

// ─── Module mocks ─────────────────────────────────────────────────

let mockStreamChat: MockStreamChat;

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => mockStreamChat,
}));

/** useAudioPlayer 的受控 play（默认解析为播放成功） */
let mockPlay: ReturnType<typeof vi.fn>;
/** useAudioPlayer 最近一次收到的 options，供试听失败用例触发 onError */
let capturedAudioPlayerOptions: { onError?: (err: Error) => void } | null = null;

vi.mock("@/hooks/use-audio-player", () => ({
  useAudioPlayer: (options?: { onError?: (err: Error) => void }) => {
    capturedAudioPlayerOptions = options ?? null;
    return {
      playing: false,
      loading: false,
      play: mockPlay,
      stop: vi.fn(),
      toggle: vi.fn(),
    };
  },
}));

// DB 层部分 mock：写路径替换为 vi.fn()，读路径（getProficiencyLevel，经
// useEffectivePracticeLevel → useProficiencyLevel → barrel）走真实 settings
// 模块——测试环境 invoke 不可用，fail-soft 回落 DEFAULT_LEVEL(B1)
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
    mockPlay = vi.fn().mockResolvedValue(true);
    capturedAudioPlayerOptions = null;
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

  it("shows level and topic selectors", () => {
    renderListeningPage();
    // 基准级别水合前为 DEFAULT_LEVEL(B1) → 派生 A2 低一档 / B1 标准 / B1+ 挑战
    expect(screen.getByRole("button", { name: /A2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^B1（≈高中/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /B1\+/ })).toBeInTheDocument();
    // 关系徽章：低一档 / 标准 / 挑战
    expect(screen.getByText("低一档")).toBeInTheDocument();
    expect(screen.getByText("标准")).toBeInTheDocument();
    expect(screen.getByText("挑战")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日常对话" })).toBeInTheDocument();
  });

  it("passes the selected level into the listening prompt", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    // 手动选择"挑战"档（B1+，相对默认基准 B1）后开始练习
    fireEvent.click(screen.getByRole("button", { name: /B1\+/ }));
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    const systemPrompt = mockStreamChat.execute.mock.calls[0][0] as string;
    expect(systemPrompt).toContain("【难度规格 · CEFR B1+");
    expect(systemPrompt).toContain("日常对话");
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

  it("calls execute with listening prompt containing the level spec block", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(mockStreamChat.execute).toHaveBeenCalled();
    });

    const systemPrompt = mockStreamChat.execute.mock.calls[0][0] as string;
    // 未手动选择时跟随基准级别的"标准"档（水合前为 DEFAULT_LEVEL B1）
    expect(systemPrompt).toContain("【难度规格 · CEFR B1");
    expect(systemPrompt).toContain("日常对话");
    expect(systemPrompt).not.toContain("初级");
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

  // ── B3：review 阶段试听失败的非阻断提示 ──

  /** 走完 生成 → 听写 → 提交 全流程，停留在 review 阶段 */
  async function reachReviewPhase() {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));
    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }
    fireEvent.click(screen.getByText(/提交/));
    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });
  }

  it("keeps review data intact and shows a warning when playback fails in review", async () => {
    await reachReviewPhase();

    // review 阶段逐句试听失败
    act(() => {
      capturedAudioPlayerOptions?.onError?.(new Error("TTS 合成失败"));
    });

    // 非阻断警告可见；得分与逐句结果仍在，整页错误分支（重试按钮）不出现
    expect(screen.getByText(/试听失败：TTS 合成失败/)).toBeInTheDocument();
    expect(screen.getByText(/得分/)).toBeInTheDocument();
    expect(screen.getByText("The quick brown fox jumps")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
  });

  it("still surfaces playback errors as a page-level error outside review", async () => {
    mockExecuteWithResult(mockStreamChat, sentencesJson);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));
    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    // listening 阶段播放失败：维持整页错误语义
    act(() => {
      capturedAudioPlayerOptions?.onError?.(new Error("TTS 合成失败"));
    });

    expect(screen.getByText(/TTS 合成失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    // 听写 UI 被错误页替换
    expect(screen.queryByPlaceholderText(/输入你听到的句子/)).not.toBeInTheDocument();
  });

  it("clears the review playback warning after a successful playback", async () => {
    await reachReviewPhase();

    act(() => {
      capturedAudioPlayerOptions?.onError?.(new Error("TTS 合成失败"));
    });
    expect(screen.getByText(/试听失败/)).toBeInTheDocument();

    // 再次试听成功（play 解析为 true）→ 警告清除
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "试听第 1 句" }));
    });

    expect(screen.queryByText(/试听失败/)).not.toBeInTheDocument();
    expect(mockPlay).toHaveBeenCalledWith("The quick brown fox jumps");
  });

  // ── B4：生成静默收尾不白屏 ──

  it("renders an error/retry UI instead of a blank page when generation ends without callbacks", async () => {
    // execute 静默 resolve（未触发 onDone/onError）：phase 停在 loading、
    // isGenerating 归位、error 为空——此前返回 null 白屏
    mockStreamChat.execute = vi.fn().mockResolvedValue(undefined);

    renderListeningPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText("生成失败，请重试。")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();

    // 重试回到 idle 选择界面
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => {
      expect(screen.getByText(/开始练习/)).toBeInTheDocument();
    });
  });
});
