/**
 * ListeningPage component-level tests.
 *
 * Strategy: mock @/hooks/use-practice-session（捕获页面 config，生成驱动方式
 * 改为"触发 generate mock"，行为由用例注入），mock useAudioPlayer to avoid
 * Tauri TTS plugin dependency.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PracticeSessionConfig } from "@/hooks/use-practice-session";
import type { ListeningSentence } from "@/types";
import ListeningPage from "./ListeningPage";

// ─── Module mocks ─────────────────────────────────────────────────

/**
 * usePracticeSession mock：捕获页面传入的 config，generate 的实现镜像真实
 * hook 的 isGenerating 生命周期（发起置 true、resolve 后复位，useRetryHint
 * 的 30 秒计时依赖它），对 config 做什么由用例注入的 generateBehavior 决定
 * （默认挂起 = 生成进行中）。
 */
type SessionConfig = PracticeSessionConfig<{ sentences: ListeningSentence[] }>;

let capturedConfig: SessionConfig | null = null;
let generateBehavior: (config: SessionConfig) => void;

const mockGenerate = vi.fn();
const mockAbort = vi.fn();
const mockPersistWithResult = vi.fn();

vi.mock("@/hooks/use-practice-session", () => ({
  usePracticeSession: (config: SessionConfig) => {
    capturedConfig = config;
    // isGenerating 用真 state 驱动，保证 useRetryHint 的计时语义与真实一致
    const [isGenerating, setIsGenerating] = useState(false);
    mockGenerate.mockImplementation(async () => {
      setIsGenerating(true);
      try {
        await generateBehavior(capturedConfig as SessionConfig);
      } finally {
        setIsGenerating(false);
      }
    });
    return {
      isGenerating,
      generate: mockGenerate,
      abort: mockAbort,
      persistWithResult: mockPersistWithResult,
    };
  },
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

// DB 层部分 mock：读路径（getProficiencyLevel，经 useEffectivePracticeLevel →
// useProficiencyLevel → barrel）走真实 settings 模块——测试环境 invoke 不可用，
// fail-soft 回落 DEFAULT_LEVEL(B1)；写路径替换为 vi.fn() 防御意外落库
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

// ─── Test fixtures & 行为注入 ─────────────────────────────────────

const sampleSentences: ListeningSentence[] = [
  { text: "The quick brown fox jumps", hint: "快速的棕色狐狸跳" },
  { text: "She sells seashells", hint: "她卖贝壳" },
  { text: "How are you doing today", hint: "你今天怎么样" },
  { text: "The weather is beautiful", hint: "天气很好" },
  { text: "I love learning English", hint: "我喜欢学英语" },
];

/** 默认行为：挂起（模拟进行中的生成，isGenerating 保持 true） */
const hangGeneration = () => new Promise<void>(() => {});

/** 生成成功：按信封形状分发解析结果（异步触发，保留可观察的 loading 帧） */
function resolveGenerationWith(sentences: ListeningSentence[]) {
  generateBehavior = (config) => {
    setTimeout(() => config.onParsed({ sentences }), 0);
  };
}

/** 解析失败：session 以 parseErrorMessage 上报并回退 idle */
function failParsing() {
  generateBehavior = (config) => {
    setTimeout(() => {
      config.reportError(config.parseErrorMessage ?? "生成失败，请重试。");
      config.onGenerationFailure?.();
    }, 0);
  };
}

/** 生成失败：session 原样上报错误消息并回退 idle（听力页无文案包装） */
function failGeneration(message: string) {
  generateBehavior = (config) => {
    setTimeout(() => {
      config.reportError(config.formatGenerationError?.(message) ?? message);
      config.onGenerationFailure?.();
    }, 0);
  };
}

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
    capturedConfig = null;
    generateBehavior = hangGeneration;
    mockGenerate.mockClear();
    mockAbort.mockClear();
    mockPersistWithResult.mockReset();
    mockPersistWithResult.mockResolvedValue(42);
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
    renderListeningPage();

    // 手动选择"挑战"档（B1+，相对默认基准 B1）后，buildMessages 读当前渲染值
    fireEvent.click(screen.getByRole("button", { name: /B1\+/ }));
    const messages = await capturedConfig?.buildMessages("");

    expect(messages?.[0]).toContain("【难度规格 · CEFR B1+");
    expect(messages?.[0]).toContain("日常对话");
  });

  it("shows start practice button", () => {
    renderListeningPage();
    expect(screen.getByText(/开始练习/)).toBeInTheDocument();
  });

  // ── Loading → listening transition ──

  it("transitions to listening phase when sentences are generated", async () => {
    resolveGenerationWith(sampleSentences);
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
    failGeneration("服务不可用");
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/服务不可用/)).toBeInTheDocument();
    });
  });

  it("shows error when LLM returns unparseable content", async () => {
    failParsing();
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
    });
  });

  it("shows retry button after error", async () => {
    failGeneration("timeout");
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/重试/)).toBeInTheDocument();
    });
  });

  it("returns to idle when retry button clicked", async () => {
    failGeneration("timeout");
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
    resolveGenerationWith(sampleSentences);
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
    resolveGenerationWith(sampleSentences);
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/下一句/));
    expect(screen.getByText(/2 \/ 5/)).toBeInTheDocument();
  });

  it("disables previous button on first sentence", async () => {
    resolveGenerationWith(sampleSentences);
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
    resolveGenerationWith(sampleSentences);
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
    resolveGenerationWith(sampleSentences);
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

  it("transitions to review phase after submitting and persists the scored result", async () => {
    resolveGenerationWith(sampleSentences);
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

    // 提交时经 persistWithResult 持久化打分后的结果对象（未作答 → 得分 0）
    expect(mockPersistWithResult).toHaveBeenCalledTimes(1);
    expect(mockPersistWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "日常对话", userInputs: Array(5).fill(""), score: 0 }),
    );

    // Should show "再来一轮" button
    expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
  });

  it("shows correct/wrong indicators in review phase", async () => {
    resolveGenerationWith(sampleSentences);
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

  it("builds the listening prompt containing the level spec block", async () => {
    renderListeningPage();

    fireEvent.click(screen.getByText(/开始练习/));

    const messages = await capturedConfig?.buildMessages("");
    // 未手动选择时跟随基准级别的"标准"档（水合前为 DEFAULT_LEVEL B1）
    expect(messages?.[0]).toContain("【难度规格 · CEFR B1");
    expect(messages?.[0]).toContain("日常对话");
    expect(messages?.[0]).not.toContain("初级");
  });

  // ── Retry hint ──

  it("shows retry hint after30 seconds", () => {
    renderListeningPage();
    fireEvent.click(screen.getByText(/开始练习/));

    // 默认 generate 挂起：isGenerating 保持 true，30 秒计时照常运行
    expect(screen.queryByText(/生成时间较长/)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(screen.getByText(/生成时间较长/)).toBeInTheDocument();
  });

  // ── B3：review 阶段试听失败的非阻断提示 ──

  /** 走完 生成 → 听写 → 提交 全流程，停留在 review 阶段 */
  async function reachReviewPhase() {
    resolveGenerationWith(sampleSentences);
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
    resolveGenerationWith(sampleSentences);
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
    // generate 静默 resolve（未触发 onParsed/reportError）：phase 停在 loading、
    // isGenerating 归位、error 为空——此前返回 null 白屏
    generateBehavior = () => {};

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
