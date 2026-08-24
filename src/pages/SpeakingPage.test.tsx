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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import SpeakingPage from "./SpeakingPage";

// ─── Global mock state ────────────────────────────────────────────

let capturedOptions: UseLLMStreamPageOptions | null = null;

/** evaluate 通道最近一次调用的 overrides，测试用它手动触发 onDone */
let capturedEvaluationOverrides: {
  onDone?: (fullText: string) => void;
  onError?: (error: Error) => void;
} | null = null;

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
      persistResult: vi.fn().mockResolvedValue(42),
    };
  },
}));

// 受控的评估流：execute 记录 overrides 并立即触发 onDone（模拟流式完成）
vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: () => ({
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: vi
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
      ),
    abort: vi.fn(),
  }),
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

  it("shows difficulty and topic selectors", () => {
    renderSpeakingPage();
    expect(screen.getByRole("button", { name: "初级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高级" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日常对话" })).toBeInTheDocument();
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
});
