/**
 * HistoryDetailPage component-level tests.
 *
 * Mock db 层 getHistoryById 与重量级子组件（SpeakButton/KnowledgeGraph/MarkdownContent），
 * 覆盖加载态、记录不存在、以及各记录类型对应详情子组件的渲染与降级路径。
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";
import HistoryDetailPage from "./HistoryDetailPage";

const mockGetHistoryById = vi.fn();

vi.mock("@/lib/db", () => ({
  getHistoryById: (...args: unknown[]) => mockGetHistoryById(...args),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => (
    <button type="button" aria-label="speak">
      speak
    </button>
  ),
}));

vi.mock("@/components/KnowledgeGraph", () => ({
  KnowledgeGraph: () => <div data-testid="knowledge-graph" />,
}));

vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

function makeRecord(over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 1,
    type: "correct",
    input_text: "original input text",
    result: "",
    graph_data: null,
    created_at: "2026-07-01T10:00:00",
    ...over,
  };
}

function renderPage(id = 1) {
  return render(
    <MemoryRouter initialEntries={[`/history/${id}`]}>
      <Routes>
        <Route path="/history/:id" element={<HistoryDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("HistoryDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while fetching", () => {
    mockGetHistoryById.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows not-found message when the record does not exist", async () => {
    mockGetHistoryById.mockResolvedValue(null);
    renderPage(999);

    await waitFor(() => {
      expect(screen.getByText("记录不存在。")).toBeInTheDocument();
    });
    expect(mockGetHistoryById).toHaveBeenCalledWith(999);
  });

  it("renders writing detail with corrections and summary", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({
        type: "correct",
        result: JSON.stringify({
          corrected_text: "The corrected full text.",
          corrections: [
            {
              original: "goed",
              corrected: "went",
              category: "时态错误",
              explanation: "过去式应为 went",
            },
          ],
          summary: "整体不错，注意时态。",
        }),
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("The corrected full text.")).toBeInTheDocument();
    });
    // 原文 + 纠错详情 + 总结
    expect(screen.getByText("original input text")).toBeInTheDocument();
    expect(screen.getByText("goed")).toBeInTheDocument();
    expect(screen.getByText("went")).toBeInTheDocument();
    expect(screen.getByText("时态错误")).toBeInTheDocument();
    expect(screen.getByText("整体不错，注意时态。")).toBeInTheDocument();
  });

  it("falls back to raw text when writing result JSON is invalid", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({ type: "correct", result: "plain non-json feedback" }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("plain non-json feedback")).toBeInTheDocument();
    });
  });

  it("renders exercise detail with category and score", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({
        type: "exercise",
        result: JSON.stringify({
          category: "拼写错误",
          exercises: [
            { type: "fill", question: "q1", answer: "a", explanation: "e1" },
            { type: "fill", question: "q2", answer: "b", explanation: "e2" },
          ],
          userAnswers: ["a", "x"],
          score: 1,
        }),
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/训练类别：拼写错误/)).toBeInTheDocument();
    });
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it("renders listening detail with per-sentence comparison", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({
        type: "listening",
        result: JSON.stringify({
          difficulty: "中级",
          topic: "日常对话",
          sentences: [{ text: "How are you today?", hint: "问候语" }],
          userInputs: ["How are you today?"],
          score: 1,
        }),
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/听力练习：日常对话 \(中级\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("How are you today?")).toBeInTheDocument();
    expect(screen.getByText("问候语")).toBeInTheDocument();
  });

  it("renders speaking detail and marks skipped sentences", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({
        type: "speaking",
        result: JSON.stringify({
          difficulty: "高级",
          topic: "商务英语",
          sentences: [
            { text: "First sentence.", translation: "第一句" },
            { text: "Second sentence.", translation: "第二句" },
          ],
          results: [
            {
              sentence: { text: "First sentence.", translation: "第一句" },
              transcription: "First sentence.",
              score: {
                pronunciation: 90,
                grammar: 88,
                fluency: 92,
                overall: 90,
                feedback: "发音清晰",
              },
            },
            {
              sentence: { text: "Second sentence.", translation: "第二句" },
              transcription: "",
              score: null,
              skipped: true,
            },
          ],
          averageScore: 90,
        }),
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/口语练习：商务英语 \(高级\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("发音清晰")).toBeInTheDocument();
    expect(screen.getByText("未完成")).toBeInTheDocument();
  });

  it("renders reading detail content", async () => {
    mockGetHistoryById.mockResolvedValue(
      makeRecord({
        type: "reading",
        result: "## 段落解析\n这是阅读分析内容。",
      }),
    );
    renderPage();

    // 无论 sections 拆分成功与否，分析内容都应被渲染
    await waitFor(() => {
      expect(screen.getByText(/这是阅读分析内容。/)).toBeInTheDocument();
    });
  });
});
