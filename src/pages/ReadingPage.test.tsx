/**
 * ReadingPage component-level tests.
 *
 * Mocks useLLMStreamPage directly with global mock state, language detection,
 * graph data, read-aloud, and other dependencies.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import ReadingPage from "./ReadingPage";

// ─── Global mock state ────────────────────────────────────────────

let mockLoading = false;
let mockError: string | null = null;
let mockResult = "";
let capturedOptions: UseLLMStreamPageOptions | null = null;
let _mockSetError: ReturnType<typeof vi.fn>;

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    // Use useState so setError triggers a real React re-render
    const [errorState, setErrorState] = useState<string | null>(mockError);
    const errorRef = useRef(errorState);
    // Sync errorRef with mockError on every render
    errorRef.current = mockError;
    return {
      loading: mockLoading,
      error: errorRef.current,
      setError: vi.fn((msg: string | null) => {
        mockError = msg;
        setErrorState(msg); // Triggers React re-render
      }),
      result: mockResult,
      setResult: vi.fn(),
      handleSubmit: vi.fn().mockImplementation(async (_input: string) => {
        options.onDone?.(mockResult, 42);
      }),
      abort: vi.fn(),
      persistResult: vi.fn().mockResolvedValue(42),
    };
  },
}));

let mockDetectLanguage: ReturnType<typeof vi.fn>;

vi.mock("@/lib/db", () => ({
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
    stopReadAloud: vi.fn(),
  }),
}));

vi.mock("@/components/KnowledgeGraph", () => ({
  KnowledgeGraph: () => null,
}));

function _simulateLLMResult(text: string) {
  act(() => {
    mockResult = text;
    mockLoading = false;
    capturedOptions?.onDone?.(text, 42);
  });
}

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

// ─── Tests ────────────────────────────────────────────────────────

describe("ReadingPage", () => {
  beforeEach(() => {
    mockLoading = false;
    mockError = null;
    mockResult = "";
    capturedOptions = null;
    mockDetectLanguage = vi.fn().mockResolvedValue({ isEnglish: true, reason: "" });
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
    const { getDefaultModelCached } = await import("@/lib/db");
    vi.mocked(getDefaultModelCached).mockResolvedValueOnce(null as never);
    renderReadingPage();

    const textarea = screen.getByPlaceholderText(/粘贴英文文章/);
    fireEvent.change(textarea, { target: { value: "English text" } });

    await act(async () => {
      fireEvent.click(screen.getByText(/Start Reading/));
    });

    expect(screen.getByText(/请先在设置页面配置/)).toBeInTheDocument();
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
});
