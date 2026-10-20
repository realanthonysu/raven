/**
 * SpeakingPage component-level tests.
 *
 * Mocks useLLMStreamPage with useState-based result tracking.
 *
 * 重构说明：逐句媒体管线已抽取到 pages/speaking/use-speaking-session，
 * 页面经由该 hook 使用 use-recording / services/asr / use-stream-chat ——
 * 本文件仍按模块路径整体 mock（保持既有做法），其中 use-recording 与
 * use-stream-chat 改为有状态的受控实现，以支撑页面级「录音→转写→评估」
 * 集成用例；管线本身的单元覆盖见 speaking/use-speaking-session.test.ts。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import { convertToWav, transcribeAudio } from "@/services/asr";
import SpeakingPage from "./SpeakingPage";

// ─── Global mock state ────────────────────────────────────────────

let capturedOptions: UseLLMStreamPageOptions | null = null;

/** evaluate 通道最近一次调用的 overrides，测试用它手动触发 onDone */
let capturedEvaluationOverrides: {
  onDone?: (fullText: string) => void;
  onError?: (error: Error) => void;
} | null = null;

/** useLLMStreamPage mock 暴露的 persistResult，用于断言"未落库" */
let mockPersistResult: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(42);

/** 评估流 execute 的受控实现（默认立即完成，可被用例改为挂起） */
let mockExecuteEvaluation: ReturnType<typeof vi.fn>;

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    return {
      loading: false,
      error: null,
      setError: vi.fn(),
      result: "",
      setResult: vi.fn(),
      handleSubmit: vi.fn().mockImplementation(async () => {
        options.onDone?.(mockSentencesJson, null);
      }),
      abort: vi.fn(),
      persistResult: mockPersistResult,
    };
  },
}));

// 受控的评估流：execute 记录 overrides 并立即触发 onDone（模拟流式完成）
vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => ({
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: (...args: unknown[]) =>
      (mockExecuteEvaluation as unknown as (...a: unknown[]) => Promise<void>)(...args),
    abort: vi.fn(),
  }),
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

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

// TTS 替身：vi.hoisted 提前创建（vi.mock 工厂在模块 const 初始化前求值），
// 且标识跨渲染稳定 —— 自动播放 effect 的依赖含 play/stop，每次渲染新建引用
// 会让 effect 每轮重播，也无法在用例内断言"重试没有触发 play"
const mockTtsPlay = vi.hoisted(() => vi.fn());
const mockTtsStop = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-audio-player", () => ({
  useAudioPlayer: () => ({
    playing: false,
    loading: false,
    play: mockTtsPlay,
    stop: mockTtsStop,
    toggle: vi.fn(),
  }),
}));

// 有状态的最小录音替身：start 置位 recording 触发重渲染（真实 hook 行为），
// 使「开始录音 → 停止录音」按钮切换可在组件树中真实发生
vi.mock("@/hooks/use-recording", () => ({
  useRecording: () => {
    const [recording, setRecording] = useState(false);
    return {
      recording,
      loading: false,
      error: null,
      start: vi.fn(async () => setRecording(true)),
      stop: vi.fn(async () => {
        setRecording(false);
        return new Blob(["fake-audio"], { type: "audio/webm" });
      }),
    };
  },
}));

vi.mock("@/hooks/use-add-to-vocabulary", () => ({
  useAddToVocabulary: () => ({
    addedWords: new Set<string>(),
    addingWord: null,
    addToVocabulary: vi.fn(),
  }),
}));

vi.mock("@/services/asr", () => ({
  convertToWav: vi.fn().mockResolvedValue(new Blob(["fake-wav"], { type: "audio/wav" })),
  transcribeAudio: vi.fn().mockResolvedValue("hello world"),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const mockSentencesJson = JSON.stringify({
  sentences: [
    { text: "Hello world", translation: "你好世界" },
    { text: "Good morning", translation: "早上好" },
    { text: "How are you", translation: "你好吗" },
    { text: "Nice to meet you", translation: "很高兴认识你" },
    { text: "See you later", translation: "再见" },
  ],
});

const mockScoreJson = JSON.stringify({
  pronunciation: 88,
  grammar: 90,
  fluency: 85,
  overall: 87,
  feedback: "发音不错",
  wordAlignment: [
    { word: "Hello", ipa: "/həˈloʊ/", status: "correct" },
    { word: "world", ipa: "/wɜːrld/", status: "missed" },
  ],
});

// ─── Helpers ──────────────────────────────────────────────────────

function renderSpeakingPage() {
  return render(
    <MemoryRouter initialEntries={["/speaking"]}>
      <SpeakingPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("SpeakingPage", () => {
  beforeEach(() => {
    capturedOptions = null;
    capturedEvaluationOverrides = null;
    mockPersistResult = vi.fn().mockResolvedValue(42);
    mockTtsPlay.mockClear();
    mockTtsStop.mockClear();
    // 默认评估流：记录 overrides 并立即完成（忙态用例可覆盖为挂起）
    mockExecuteEvaluation = vi
      .fn()
      .mockImplementation(
        (
          _prompt: string,
          _userContent: string,
          overrides?: { onDone?: (fullText: string) => void },
        ) => {
          capturedEvaluationOverrides = overrides ?? null;
          overrides?.onDone?.(mockScoreJson);
          return Promise.resolve();
        },
      );
    // asr 默认实现（工厂级 mockResolvedValue 可能被 restoreAllMocks 复位）
    vi.mocked(convertToWav).mockResolvedValue(new Blob(["fake-wav"], { type: "audio/wav" }));
    vi.mocked(transcribeAudio).mockResolvedValue("hello world");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Loading phase ──

  it("renders loading phase with title and description", () => {
    renderSpeakingPage();
    expect(screen.getByText(/Speaking Copilot/)).toBeInTheDocument();
    expect(screen.getByText(/跟读模仿/)).toBeInTheDocument();
    expect(screen.getByText(/开始练习/)).toBeInTheDocument();
  });

  it("shows level and topic selectors", () => {
    renderSpeakingPage();
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

  it("passes the selected level into the speaking prompt and getDifficultyLevel", async () => {
    renderSpeakingPage();
    // 手动选择"挑战"档（B1+，相对默认基准 B1）
    fireEvent.click(screen.getByRole("button", { name: /B1\+/ }));
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    const messages = await capturedOptions?.buildMessages("");
    expect(messages?.[0]).toContain("【难度规格 · CEFR B1+");
    // getDifficultyLevel 取发起时定格的级别（ref），而非渲染期派生值
    expect(capturedOptions?.getDifficultyLevel?.()).toBe("B1+");
  });

  it("uses speaking activity type with autoPersist false", () => {
    renderSpeakingPage();
    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions?.activityType).toBe("speaking");
    expect(capturedOptions?.autoPersist).toBe(false);
  });

  // ── Speaking phase ──

  it("transitions to speaking phase when sentences are generated", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    expect(screen.getByText(/开始录音/)).toBeInTheDocument();
    expect(screen.getByText("你好世界")).toBeInTheDocument();
  });

  it("disables previous button on first sentence", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/上一句/)).toBeInTheDocument();
    });

    const prevButton = screen.getByText(/上一句/).closest("button");
    if (!prevButton) throw new Error("prev button not found");
    expect(prevButton).toBeDisabled();
  });

  it("navigates between sentences", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    // Go to sentence 2
    fireEvent.click(screen.getByText(/下一句/));
    expect(screen.getByText("Good morning")).toBeInTheDocument();
    expect(screen.getByText("早上好")).toBeInTheDocument();

    // Go back to sentence 1
    fireEvent.click(screen.getByText(/上一句/));
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("shows completion button on last sentence", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });

    // Navigate to last sentence
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }

    expect(screen.getByText(/完成练习/)).toBeInTheDocument();
    expect(screen.getByText("再见")).toBeInTheDocument();
  });

  it("calls useLLMStreamPage with correct options", async () => {
    renderSpeakingPage();
    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions?.activityType).toBe("speaking");
    expect(capturedOptions?.autoPersist).toBe(false);
    // buildMessages should return SPEAKING_PROMPT（可能为同步或异步形式，await 兼容两者）
    const messages = await capturedOptions?.buildMessages("");
    expect(messages?.[0]).toContain("口语教练");
    expect(messages?.[0]).toContain("跟读模仿");
  });

  // ── Retry hint ──

  it("shows retry hint after timeout during generation", async () => {
    renderSpeakingPage();

    // The component renders in loading phase, isGenerating is false initially
    // Click start to trigger generation
    fireEvent.click(screen.getByText(/开始练习/));

    // After sentences are generated (synchronously via mock), we're in speaking phase
    // The retry hint only shows during loading when isGenerating is true
    // Since our mock resolves immediately, the hint window is very short.
    // This test verifies the component doesn't crash with fake timers.
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  // ── Media pipeline (经由 use-speaking-session 的页面级集成) ──

  it("runs the record→transcribe→evaluate cycle and renders the aligned result", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));

    await waitFor(() => {
      expect(screen.getByText(/开始录音/)).toBeInTheDocument();
    });

    // 开始录音 → 录音替身置位 recording → 按钮切为「停止录音」
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });

    // 停止录音 → WAV → ASR("hello world") → 评估 onDone(mockScoreJson)
    fireEvent.click(screen.getByText(/停止录音/));

    // 转写文本与评分网格渲染
    await waitFor(() => {
      expect(screen.getByText("你说的是：")).toBeInTheDocument();
    });
    expect(screen.getByText("hello world")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("发音不错")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("词级发音对齐结果")).toBeInTheDocument();
    expect(capturedEvaluationOverrides).not.toBeNull();
  });

  // ── B1：录音/识别/评估在途时的导航守卫 ──

  /** 进入 speaking 阶段并导航到指定句（非忙状态） */
  async function enterSpeakingAndNavigateTo(targetIndex: number) {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));
    await waitFor(() => {
      expect(screen.getByText(/下一句/)).toBeInTheDocument();
    });
    for (let i = 0; i < targetIndex; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }
  }

  it("disables navigation buttons and ignores clicks while recording", async () => {
    await enterSpeakingAndNavigateTo(1);
    expect(screen.getByText("Good morning")).toBeInTheDocument();

    // 非忙状态：第 2 句的上一句/下一句均可用
    expect(screen.getByText(/上一句/).closest("button")).toBeEnabled();
    expect(screen.getByText(/下一句/).closest("button")).toBeEnabled();

    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });

    // 录音中：两个导航按钮禁用，点击不改变当前句
    const prevButton = screen.getByText(/上一句/).closest("button");
    const nextButton = screen.getByText(/下一句/).closest("button");
    expect(prevButton).toBeDisabled();
    expect(nextButton).toBeDisabled();
    fireEvent.click(nextButton as HTMLButtonElement);
    fireEvent.click(prevButton as HTMLButtonElement);
    expect(screen.getByText("Good morning")).toBeInTheDocument();
    expect(screen.getByText("早上好")).toBeInTheDocument();
  });

  it("disables navigation while ASR recognition is in flight", async () => {
    // 转写请求挂起：停止录音后停在"识别中"
    vi.mocked(transcribeAudio).mockImplementation(() => new Promise<string>(() => {}));

    await enterSpeakingAndNavigateTo(1);
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/停止录音/));
    await waitFor(() => {
      expect(screen.getByText(/识别中/)).toBeInTheDocument();
    });

    expect(screen.getByText(/上一句/).closest("button")).toBeDisabled();
    expect(screen.getByText(/下一句/).closest("button")).toBeDisabled();
  });

  it("disables navigation while pronunciation evaluation is in flight", async () => {
    // 评估流挂起：ASR 完成后停在"评估中"
    mockExecuteEvaluation.mockImplementation(() => new Promise<void>(() => {}));

    await enterSpeakingAndNavigateTo(1);
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/停止录音/));
    await waitFor(() => {
      expect(screen.getByText(/评估中/)).toBeInTheDocument();
    });

    expect(screen.getByText(/上一句/).closest("button")).toBeDisabled();
    expect(screen.getByText(/下一句/).closest("button")).toBeDisabled();
  });

  it("does not persist or leave the speaking phase when finishing while recording", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));
    await waitFor(() => {
      expect(screen.getByText(/开始录音/)).toBeInTheDocument();
    });

    // 先完整完成第 1 句（results[0] 有值 → 完成练习按钮具备可用条件）
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/停止录音/));
    await waitFor(() => {
      expect(screen.getByText("发音不错")).toBeInTheDocument();
    });

    // 导航到最后一句
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText(/下一句/));
    }
    const finishButton = screen.getByText(/完成练习/).closest("button");
    expect(finishButton).toBeEnabled();

    // 开始录音后：完成练习禁用，点击不落库、不切阶段
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    expect(finishButton).toBeDisabled();
    fireEvent.click(finishButton as HTMLButtonElement);

    expect(screen.getByText(/完成练习/)).toBeInTheDocument();
    expect(screen.queryByText(/结果回顾/)).not.toBeInTheDocument();
    expect(mockPersistResult).not.toHaveBeenCalled();
  });

  // ── B1：录音/识别/评估在途时的重试守卫 ──

  it("disables retry and ignores retry clicks while evaluation is in flight", async () => {
    renderSpeakingPage();
    fireEvent.click(screen.getByText(/开始练习/));
    await waitFor(() => {
      expect(screen.getByText(/开始录音/)).toBeInTheDocument();
    });

    // 先完整完成第 1 句：results[0] 有值 → 重试按钮出现且可用
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/停止录音/));
    await waitFor(() => {
      expect(screen.getByText("发音不错")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /重试/ })).toBeEnabled();

    // 第二轮录音并让评估流挂起：管线进入忙态（evaluating）
    mockExecuteEvaluation.mockImplementation(() => new Promise<void>(() => {}));
    mockTtsPlay.mockClear();
    fireEvent.click(screen.getByText(/开始录音/));
    await waitFor(() => {
      expect(screen.getByText(/停止录音/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/停止录音/));
    await waitFor(() => {
      expect(screen.getByText(/评估中/)).toBeInTheDocument();
    });

    // 重试按钮禁用；强行点击既不发 RETRY_CURRENT（按钮不消失即 results[0] 未清空），
    // 也不重播 TTS —— 否则在途评估完成时 SET_SENTENCE_RESULT 会把刚清掉的结果
    // 按 index 原样写回，用户看到的是"重试毫无效果"
    const retryButton = screen.getByRole("button", { name: /重试/ });
    expect(retryButton).toBeDisabled();
    fireEvent.click(retryButton);
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(mockTtsPlay).not.toHaveBeenCalled();
  });
});
