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
import { PageVisibilityProvider } from "@/contexts/PageVisibilityContext";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import ReadingPage from "./ReadingPage";

// ─── Global mock state ────────────────────────────────────────────

let mockLoading = false;
let mockError: string | null = null;
let mockResult = "";
let capturedOptions: UseLLMStreamPageOptions | null = null;
/** 捕获 mock handleSubmit 中经 buildMessages 构建的 [system, user] 消息 */
let capturedMessages: [string, string] | null = null;

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
    return {
      loading: mockLoading,
      error: errorRef.current,
      setError,
      result: mockResult,
      setResult: vi.fn(),
      handleSubmit: (...args: unknown[]) => mockHandleSubmit(...args),
      abort: vi.fn(),
      persistResult: vi.fn().mockResolvedValue(42),
    };
  },
}));

let mockDetectLanguage: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
let mockStopReadAloud: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
/** 捕获 mock handleSubmit，供断言"检测未放行时六维分析不发起" */
let mockHandleSubmit: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;

// DB 层整体 mock：走共享 fake（src/test/db-mock.ts），替代手写字面量 mock。
// 此前为 importOriginal 部分替换 + 读路径（getProficiencyLevel）走真实 settings
// 模块靠 invoke 失败 fail-soft 回落 DEFAULT_LEVEL(B1)；fake 的 getProficiencyLevel
// 默认即解析 B1，两者对页面的可观察行为等价
vi.mock("@/lib/db", async () => {
  const { createDbMock } = await import("@/test/db-mock");
  return createDbMock({
    getDefaultModelCached: vi.fn().mockResolvedValue({
      id: 1,
      name: "test",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
      model_name: "gpt-4o-mini",
      is_default: true,
    }),
  });
});

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
      {/* 页面经 PageVisibilityContext 读「是否被壳隐藏」；此处包 Provider 模拟
          PersistentRoutes 的判定（与 useLocation 同源），导航离开用例才可触发 */}
      <PageVisibilityProvider>
        <NavigateButton to="/vocabulary" />
        <ReadingPage />
      </PageVisibilityProvider>
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
    mockHandleSubmit = vi.fn().mockImplementation(async (input: string) => {
      // 走真实 buildMessages（页面在此读取级别并构建提示词），
      // 使级别注入与 getDifficultyLevel 快照可被断言
      // （capturedOptions 在调用时才读取——beforeEach 时它还是 null）
      const options = capturedOptions;
      if (!options) return;
      capturedMessages = await options.buildMessages(input);
      options.onDone?.(mockResult, 42);
    });
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

    // Verify language detection was called with just the input text
    // （模型解析已收编进检测 hook，页面不再传入模型）
    expect(mockDetectLanguage).toHaveBeenCalledWith("The weather is nice today.");
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

  it("blocks the flow when language detection fails closed (model not configured)", async () => {
    // 页面契约（新）：模型解析收编进检测 hook，不再有页面级 resolveModel 前置
    // 预检；未配置模型时检测内部报 not-configured 并映射为通道规范文案的
    // fail-closed 结果，页面据此拦截（映射见 use-language-detection）
    mockDetectLanguage.mockResolvedValue({
      isEnglish: false,
      reason: "请先在设置页面配置 LLM 模型。",
    });
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "English text" } });

    await act(async () => {
      fireEvent.click(screen.getByText(/Start Reading/));
    });

    await waitFor(() => {
      expect(mockDetectLanguage).toHaveBeenCalled();
    });

    expect(screen.getByText(/仅支持英文输入/)).toBeInTheDocument();
    // 检测未放行：六维分析不应发起
    expect(mockHandleSubmit).not.toHaveBeenCalled();
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

  it("renders the original article as per-word buttons after analysis", async () => {
    mockResult = readingResult;
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "Hello brave new world." } });
    fireEvent.click(screen.getByText(/Start Reading/));

    await waitFor(() => {
      expect(screen.getByText(/参考翻译/)).toBeInTheDocument();
    });

    // SentenceRow 重构后仍保持"每个 token 一个 button"的查词结构
    expect(screen.getByRole("button", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "world." })).toBeInTheDocument();
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
