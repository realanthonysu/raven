/**
 * CorrectPage component-level tests.
 *
 * Mocks useLLMStreamPage with useState-based result tracking so that
 * handleSubmit's setResult triggers a real React re-render.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseLLMStreamPageOptions } from "@/hooks/use-llm-stream-page";
import CorrectPage from "./CorrectPage";

// ─── Module mocks ─────────────────────────────────────────────────

let capturedOptions: UseLLMStreamPageOptions | null = null;

vi.mock("@/hooks/use-llm-stream-page", () => ({
  useLLMStreamPage: (options: UseLLMStreamPageOptions) => {
    capturedOptions = options;
    const [resultState, setResultState] = useState<string>("");
    return {
      loading: false,
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
      abort: vi.fn(),
      persistResult: vi.fn().mockResolvedValue(42),
    };
  },
}));

let mockResult = "";

vi.mock("@/lib/db", () => ({
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

// ─── Helpers ──────────────────────────────────────────────────────

function renderCorrectPage() {
  return render(
    <MemoryRouter initialEntries={["/writing"]}>
      <CorrectPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("CorrectPage", () => {
  beforeEach(() => {
    mockResult = "";
    capturedOptions = null;
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
});
