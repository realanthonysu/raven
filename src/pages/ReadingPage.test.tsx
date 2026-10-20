/**
 * ReadingPage component-level tests.
 *
 * Mocks useLLMStreamPage directly with global mock state, language detection,
 * graph data, read-aloud, and other dependencies.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import ReadingPage from "./ReadingPage";

// ─── Global mock state ────────────────────────────────────────────

let mockLoading = false;
let mockError: string | null = null;
let mockResult = "";
let capturedOptions: UseLLMStreamPageOptions | null = null;
/** 捕获 mock handleSubmit 中经 buildMessages 构建的 [system, user] 消息 */
let capturedMessages: [string, string] | null = null;
/** 捕获最近一次渲染的 setError，供模拟“hook 内部设置错误”的场景使用 */
let lastSetError: ((msg: string | null) => void) | null = null;
let mockResolveModel: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    // Use useState so setError triggers a real React re-render
    const [errorState, setErrorState] = useState<string | null>(mockError);
    const errorRef = useRef(errorState);
    // Sync errorRef with mockError on every render
    errorRef.current = mockError;
    const setError = vi.fn((msg: string | null) => {
      mockError = msg;
      setErrorState(msg); // Triggers React re-render
    });
    lastSetError = setError;
    return {
      loading: mockLoading,
      error: errorRef.current,
      setError,
      result: mockResult,
      setResult: vi.fn(),
      handleSubmit: vi.fn().mockImplementation(async (input: string) => {
        // 走真实 buildMessages（页面在此读取级别并构建提示词），
        // 使级别注入与 getDifficultyLevel 快照可被断言
        capturedMessages = await options.buildMessages(input);
        options.onDone?.(mockResult, 42);
      }),
      abort: vi.fn(),
      persistResult: vi.fn().mockResolvedValue(42),
      resolveModel: (...args: unknown[]) => mockResolveModel(...args),
    };
  },
}));

let mockDetectLanguage: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
let mockStopReadAloud: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

// DB 层部分 mock：写路径与模型查询替换为 vi.fn()，读路径（getProficiencyLevel）
// 经 barrel 走真实 settings 模块——测试环境 invoke 不可用，fail-soft 回落
// DEFAULT_LEVEL(B1)，与改动前（深路径导入真实 settings）行为一致
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  addHistorySafe: vi.fn().mockResolvedValue(42),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
  getDefaultModelCached: vi.fn().mockResolvedValue({
    id: 1,
    name: "test",
    api_key: "sk-test",
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o-mini",
    is_default: true,
  }),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@/hooks/use-add-to-vocabulary", () => ({
  useAddToVocabulary: () => ({
    addedWords: new Set<string>(),
    addingWord: null,
    enriching: false,
    addToVocabulary: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-language-detection", () => ({
  useLanguageDetection: () => ({
    detecting: false,
    detectLanguage: (...args: unknown[]) => mockDetectLanguage(...args),
    cancelDetection: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-graph-data", () => ({
  useGraphData: () => ({
    graphData: null,
    graphLoading: false,
    graphError: null,
    fetchGraph: vi.fn(),
    clearGraph: vi.fn(),
    cancelGraph: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-read-aloud", () => ({
  useReadAloud: () => ({
    readAloudActive: false,
    currentSentenceIndex: -1,
    startReadAloud: vi.fn(),
    stopReadAloud: (...args: unknown[]) => mockStopReadAloud(...args),
  }),
}));

vi.mock("@/components/KnowledgeGraph", () => ({
  KnowledgeGraph: () => null,
}));

// ─── Test fixtures ────────────────────────────────────────────────

const readingResult = `## 参考翻译
今天天气很好。

## 重点词汇
weather - 天气

## 复杂句式
简单句

## 语法结构
一般现在时

## 背景知识
天气相关

## 延伸思考
学好英语`;

// ─── Helpers ──────────────────────────────────────────────────────

function renderReadingPage() {
  return render(
    <MemoryRouter initialEntries={["/reading"]}>
      <ReadingPage />
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

function renderReadingPageWithNav(initial = "/reading") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <NavigateButton to="/vocabulary" />
      <ReadingPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ReadingPage", () => {
  beforeEach(() => {
    mockLoading = false;
    mockError = null;
    mockResult = "";
    capturedOptions = null;
    capturedMessages = null;
    mockDetectLanguage = vi.fn().mockResolvedValue({ isEnglish: true, reason: "" });
    mockStopReadAloud = vi.fn();
    // 默认解析出已配置模型（与真实 resolveModel 契约一致）
    mockResolveModel = vi
      .fn()
      .mockResolvedValue({ id: 1, name: "test", api_key: "sk-test", model_name: "gpt-4o-mini" });
    lastSetError = null;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Initial state ──

  it("renders the page title and empty state", () => {
    renderReadingPage();
    expect(screen.getByText(/Reading Copilot/)).toBeInTheDocument();
    expect(screen.getByText(/粘贴英文文章/)).toBeInTheDocument();
  });

  it("renders the input textarea and submit button", () => {
    renderReadingPage();
    expect(screen.getByPlaceholderText(/粘贴英文文章/)).toBeInTheDocument();
    expect(screen.getByText(/Start Reading/)).toBeInTheDocument();
  });

  // ── Submission flow ──

  it("does not submit when input is empty", async () => {
    renderReadingPage();
    fireEvent.click(screen.getByText(/Start Reading/));
    expect(mockDetectLanguage).not.toHaveBeenCalled();
  });

  it("detects language before submitting to LLM", async () => {
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "The weather is nice today." } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(mockDetectLanguage).toHaveBeenCalled();
    });

    // Verify language detection was called with the input text
    expect(mockDetectLanguage).toHaveBeenCalledWith(
      "The weather is nice today.",
      expect.objectContaining({ api_key: "sk-test" }),
    );
  });

  it("blocks non-English input with error message", async () => {
    mockDetectLanguage.mockResolvedValue({ isEnglish: false, reason: "检测到中文" });
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "今天天气很好" } });

    await act(async () => {
      fireEvent.click(screen.getByText(/Start Reading/));
    });

    await waitFor(() => {
      expect(mockDetectLanguage).toHaveBeenCalled();
    });

    expect(screen.getByText(/仅支持英文输入/)).toBeInTheDocument();
  });

  it("shows error when no model is configured", async () => {
    // 页面契约：模型缺失由 useStreamChat.resolveModel 统一设置规范错误文案并返回 null，
    // 页面据此中止（不再自行调用 getDefaultModelCached / 复制文案）
    mockResolveModel.mockImplementation(async () => {
      lastSetError?.("请先在设置页面配置 LLM 模型。");
      return null;
    });
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "English text" } });

    await act(async () => {
      fireEvent.click(screen.getByText(/Start Reading/));
    });

    expect(screen.getByText(/请先在设置页面配置/)).toBeInTheDocument();
    // 未配置模型时不应进入语言检测步骤
    expect(mockDetectLanguage).not.toHaveBeenCalled();
  });

  // ── Results rendering ──

  it("renders parsed sections after successful analysis", async () => {
    mockResult = readingResult;
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "The weather is nice today." } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(screen.getByText(/参考翻译/)).toBeInTheDocument();
    });

    expect(screen.getByText(/今天天气很好/)).toBeInTheDocument();
    // "weather" appears in both section content and vocabulary; check at least one exists
    expect(screen.getAllByText(/weather/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders raw result when no sections are parsed", async () => {
    mockResult = "Plain text without any headers";
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "Some text" } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(screen.getByText(/Plain text without any headers/)).toBeInTheDocument();
    });
  });

  // ── Hook options ──

  it("uses reading activity type", async () => {
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.click(screen.getByText(/Start Reading/));

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions?.activityType).toBe("reading");
  });

  // ── 英语水平级别（Track 1） ──

  it("shows the current proficiency level badge above the input", () => {
    renderReadingPage();
    // 测试环境 settings 读取失败 → 回退默认级别 B1
    expect(screen.getByText("当前级别")).toBeInTheDocument();
    expect(screen.getByText("B1（≈高中 · 高考）")).toBeInTheDocument();
  });

  it("builds the prompt with the level spec block and snapshots the level", async () => {
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "The weather is nice today." } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(capturedMessages).not.toBeNull();
    });

    // buildReadingPrompt(B1)：读者水平引导行 + 末尾难度规格块
    expect(capturedMessages?.[0]).toContain("读者水平：CEFR B1（≈高中 · 高考）");
    expect(capturedMessages?.[0]).toContain("【难度规格 · CEFR B1，≈高中 · 高考】");
    expect(capturedMessages?.[1]).toBe("The weather is nice today.");

    // getDifficultyLevel 返回本次生成使用的级别（hook 持久化时写入 difficulty_level）
    expect(capturedOptions?.getDifficultyLevel?.()).toBe("B1");
  });

  // ── Reset ──

  it("resets state when new article button clicked after results", async () => {
    mockResult = readingResult;
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "English text" } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(screen.getByText(/参考翻译/)).toBeInTheDocument();
    });

    // Find and click the new article button
    const resetButton = screen.getByText(/新文章/);
    fireEvent.click(resetButton);

    // Should be back to empty state
    expect(screen.getByPlaceholderText(/粘贴英文文章/)).toHaveValue("");
  });

  // ── PersistentRoutes 隐藏语义：导航离开停止朗读 ──

  it("stops read-aloud exactly when navigating away from /reading", () => {
    renderReadingPageWithNav();

    // 挂载/显示期间不触发（useHiddenEffect 契约）
    expect(mockStopReadAloud).not.toHaveBeenCalled();

    // 离开持久化路径的瞬间停止朗读（行为变更：此前导航离开后朗读继续逐句播放）
    fireEvent.click(screen.getByText("nav-away"));

    expect(mockStopReadAloud).toHaveBeenCalledTimes(1);
  });
});
