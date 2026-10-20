/**
 * CorrectPage component-level tests.
 *
 * Mocks useLLMStreamPage with useState-based result tracking so that
 * handleSubmit's setResult triggers a real React re-render.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import CorrectPage from "./CorrectPage";

// ─── Module mocks ─────────────────────────────────────────────────

let capturedOptions: UseLLMStreamPageOptions | null = null;
let mockLoading = false;
const mockAbort = vi.fn();

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    const [resultState, setResultState] = useState<string>("");
    return {
      loading: mockLoading,
      error: null,
      setError: vi.fn(),
      result: resultState,
      setResult: setResultState,
      handleSubmit: vi.fn().mockImplementation(async () => {
        // Simulate LLM response: call onDone with the pre-set mockResult
        // then update resultState so the component re-renders with the result.
        // Note: onDone fires first (matching real hook behavior), then result updates.
        options.onDone?.(mockResult, 42);
        setResultState(mockResult);
      }),
      abort: (...args: unknown[]) => mockAbort(...args),
      persistResult: vi.fn().mockResolvedValue(42),
    };
  },
}));

let mockResult = "";

const mockStopActivePlayback = vi.fn();

vi.mock("@/hooks/use-audio-player", () => ({
  // CorrectPage 自身不调用 useAudioPlayer（音频来自子级 SpeakButton），
  // 这里只需提供模块级 stopActivePlayback 的 spy
  useAudioPlayer: () => ({
    playing: false,
    loading: false,
    play: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  }),
  stopActivePlayback: (...args: unknown[]) => mockStopActivePlayback(...args),
}));

// DB 层部分 mock：写路径替换为 vi.fn()，读路径（getProficiencyLevel）经 barrel
// 走真实 settings 模块——测试环境 invoke 不可用，fail-soft 回落 DEFAULT_LEVEL(B1)
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  addHistorySafe: vi.fn().mockResolvedValue(42),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@/hooks/use-add-to-vocabulary", () => ({
  useAddToVocabulary: () => ({
    addedWords: new Set<string>(),
    addingWord: null,
    addToVocabulary: vi.fn(),
  }),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const correctionResult = {
  corrected_text: "She goes to school every day.",
  corrections: [
    {
      original: "She go to school every day.",
      corrected: "She goes to school every day.",
      category: "主谓一致",
      explanation: "第三人称单数主语需要使用动词第三人称单数形式",
    },
  ],
  summary: "注意主谓一致，第三人称单数主语后动词要加s。",
};

/** 带写作水平估级的纠错结果（Track 3：level_estimate） */
const correctionResultWithLevel = {
  ...correctionResult,
  level_estimate: {
    band: "B1+",
    rationale: "词汇较丰富，时态错误偏多，句式以简单句为主。",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────

function renderCorrectPage() {
  return render(
    <MemoryRouter initialEntries={["/writing"]}>
      <CorrectPage />
    </MemoryRouter>,
  );
}

/** 测试用导航按钮：模拟用户从持久化页面离开（Sidebar 导航的等价物） */
function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      nav-away
    </button>
  );
}

function renderCorrectPageWithNav(initial = "/writing") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <NavigateButton to="/vocabulary" />
      <CorrectPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("CorrectPage", () => {
  beforeEach(() => {
    mockResult = "";
    capturedOptions = null;
    mockLoading = false;
    mockAbort.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Initial state ──

  it("renders the page title and empty state", () => {
    renderCorrectPage();
    expect(screen.getByText(/Writing Copilot/)).toBeInTheDocument();
    expect(screen.getByText(/粘贴英文文本/)).toBeInTheDocument();
  });

  it("renders the input textarea and submit button", () => {
    renderCorrectPage();
    expect(screen.getByPlaceholderText(/输入英文文本/)).toBeInTheDocument();
    expect(screen.getByText(/Check Writing/)).toBeInTheDocument();
  });

  // ── Submission ──

  it("submits input to LLM and displays correction result", async () => {
    mockResult = JSON.stringify(correctionResult);
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "She go to school every day." } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText(/Corrected/)).toBeInTheDocument();
    });

    expect(screen.getAllByText(/She goes to school every day/).length).toBeGreaterThanOrEqual(1);
    // "主谓一致" appears in both category badge and summary text
    expect(screen.getAllByText(/主谓一致/).length).toBeGreaterThanOrEqual(1);
    // "第三人称单数" appears in both correction explanation and summary
    expect(screen.getAllByText(/第三人称单数/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/注意主谓一致/)).toBeInTheDocument();
  });

  it("displays raw result when JSON parsing fails", async () => {
    mockResult = "This is plain text, not JSON";
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "Some text" } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText(/This is plain text, not JSON/)).toBeInTheDocument();
    });
  });

  it("sends the correct activity type", async () => {
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.click(screen.getByText(/Check Writing/));

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions?.activityType).toBe("writing");
  });

  it("handles result with empty corrections array", async () => {
    mockResult = JSON.stringify({
      corrected_text: "Perfect sentence.",
      corrections: [],
      summary: "表达准确，无需修改。",
    });
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "Perfect sentence." } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText(/Corrected/)).toBeInTheDocument();
    });

    expect(screen.getByText(/表达准确/)).toBeInTheDocument();
    expect(screen.queryByText(/Corrections/)).not.toBeInTheDocument();
  });

  // ── CEFR 级别体系（Track 3）：难度级别接线与估级徽章 ──

  it("exposes getDifficultyLevel for history persistence", () => {
    renderCorrectPage();

    // 提交前 levelRef 为空，getDifficultyLevel 返回 null（存 null）
    expect(capturedOptions).not.toBeNull();
    expect(typeof capturedOptions?.getDifficultyLevel).toBe("function");
    expect(capturedOptions?.getDifficultyLevel?.()).toBeNull();
  });

  it("displays the level estimate badge with rationale", async () => {
    mockResult = JSON.stringify(correctionResultWithLevel);
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "She go to school every day." } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText("估级 B1+")).toBeInTheDocument();
    });
    expect(screen.getByText("词汇较丰富，时态错误偏多，句式以简单句为主。")).toBeInTheDocument();
  });

  it("hides the level estimate badge for invalid band (old data compat)", async () => {
    mockResult = JSON.stringify({
      ...correctionResult,
      level_estimate: { band: "Z9", rationale: "意外档位" },
    });
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "She go to school every day." } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText(/Corrected/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/估级/)).not.toBeInTheDocument();
  });

  it("shows no level estimate badge for results without the field", async () => {
    mockResult = JSON.stringify(correctionResult);
    renderCorrectPage();

    const textarea = screen.getByPlaceholderText(/输入英文文本/);
    fireEvent.change(textarea, { target: { value: "She go to school every day." } });
    fireEvent.click(screen.getByText(/Check Writing/));

    await waitFor(() => {
      expect(screen.getByText(/Corrected/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/估级/)).not.toBeInTheDocument();
  });

  // ── PersistentRoutes 隐藏语义：导航离开停止音频 ──

  it("stops active audio exactly when navigating away from /writing", () => {
    renderCorrectPageWithNav();

    // 挂载/显示期间不触发（useHiddenEffect 契约）
    expect(mockStopActivePlayback).not.toHaveBeenCalled();

    // 离开持久化路径的瞬间停止音频（行为变更：此前导航离开后音频继续播放）
    fireEvent.click(screen.getByText("nav-away"));

    expect(mockStopActivePlayback).toHaveBeenCalledTimes(1);
  });

  // ── 取消（与其他 LLM 页面的中止能力对齐） ──

  it("shows no cancel button while idle", () => {
    renderCorrectPage();
    expect(screen.queryByText(/停止生成/)).not.toBeInTheDocument();
  });

  it("shows cancel button while loading and aborts on click", () => {
    mockLoading = true;
    renderCorrectPage();

    const cancelButton = screen.getByText(/停止生成/);
    fireEvent.click(cancelButton);

    // abort 停止本地 token 处理（Rust 侧请求按其超时自行结束）
    expect(mockAbort).toHaveBeenCalledTimes(1);
  });
});
