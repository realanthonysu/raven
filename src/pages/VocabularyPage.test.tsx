/**
 * VocabularyPage component-level tests.
 *
 * Mocks db functions (getWords, deleteWord, updateWordLevel, etc.),
 * SpeakButton, Tauri dialog plugin, and LLM enrichment service.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "@/types";

import VocabularyPage from "./VocabularyPage";

// ─── Module mocks ─────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  getWords: vi.fn().mockResolvedValue([]),
  deleteWord: vi.fn().mockResolvedValue(undefined),
  updateWordLevel: vi.fn().mockResolvedValue(undefined),
  updateWordEnrichment: vi.fn().mockResolvedValue(undefined),
  addWord: vi.fn().mockResolvedValue({ lastInsertId: 99 }),
  exportWordsCsv: vi.fn().mockResolvedValue("word,phonetic\nhello,/həˈloʊ/"),
  exportWordsAnki: vi.fn().mockResolvedValue("hello\t/həˈloʊ/\t你好"),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/services/llm", () => ({
  enrichWord: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/csv-utils", () => ({
  parseCsvLine: (line: string) => line.split(","),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const sampleWords: Word[] = [
  {
    id: 1,
    word: "ephemeral",
    phonetic: "/ɪˈfemərəl/",
    definition: "短暂的，转瞬即逝的",
    level: "CET-6",
    source_type: "reading",
    source_text: "Fame is ephemeral.",
    notes: "搭配: ephemeral beauty\n例句: Fame is ephemeral.",
    review_status: "learning",
    review_count: 3,
    next_review_at: "2026-08-01T00:00:00",
    created_at: "2026-01-01T00:00:00",
  },
  {
    id: 2,
    word: "ubiquitous",
    phonetic: "/juːˈbɪkwɪtəs/",
    definition: "无处不在的",
    level: "TEM-4",
    source_type: "correct",
    source_text: "Smartphones are ubiquitous.",
    notes: null,
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-01-02T00:00:00",
  },
  {
    id: 3,
    word: "resilience",
    phonetic: null,
    definition: "待补充",
    level: null,
    source_type: "manual",
    source_text: null,
    notes: null,
    review_status: "new",
    review_count: 0,
    next_review_at: null,
    created_at: "2026-01-03T00:00:00",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────

function renderVocabularyPage() {
  return render(
    <MemoryRouter initialEntries={["/vocabulary"]}>
      <VocabularyPage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("VocabularyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Page title ──

  it("renders page title", async () => {
    renderVocabularyPage();
    expect(screen.getByRole("heading", { name: /生词本/ })).toBeInTheDocument();
  });

  // ── Empty state ──

  it("shows empty state when no words", async () => {
    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/生词本暂无词汇/)).toBeInTheDocument();
    });

    expect(screen.getByText(/手动添加、导入 CSV/)).toBeInTheDocument();
  });

  // ── Word list ──

  it("renders word list when data is loaded", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
      expect(screen.getByText("ubiquitous")).toBeInTheDocument();
      expect(screen.getByText("resilience")).toBeInTheDocument();
    });

    // Should display phonetic for words that have it
    expect(screen.getByText("/ɪˈfemərəl/")).toBeInTheDocument();
    expect(screen.getByText("/juːˈbɪkwɪtəs/")).toBeInTheDocument();

    // Should display definitions
    expect(screen.getByText("短暂的，转瞬即逝的")).toBeInTheDocument();
    expect(screen.getByText("无处不在的")).toBeInTheDocument();

    // Should show word count
    expect(screen.getByText(/共 3 个单词/)).toBeInTheDocument();
  });

  it("renders level badges for words that have levels", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // CET-6 badge for ephemeral
    const cet6Badges = screen.getAllByText("CET-6");
    expect(cet6Badges.length).toBeGreaterThanOrEqual(1);

    // TEM-4 badge for ubiquitous
    const tem4Badges = screen.getAllByText("TEM-4");
    expect(tem4Badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders notes when available", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/ephemeral beauty/)).toBeInTheDocument();
    });
  });

  // ── Delete word ──

  it("can delete a word", async () => {
    const { getWords, deleteWord } = await import("@/lib/db");
    vi.mocked(getWords)
      .mockResolvedValueOnce(sampleWords)
      .mockResolvedValueOnce(sampleWords.filter((w) => w.id !== 1));
    vi.mocked(deleteWord).mockResolvedValue(undefined);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Find all delete buttons (Trash2 icon buttons) and click the first one
    const deleteButtons = screen.getAllByRole("button").filter((btn) => {
      // Delete buttons are ghost variant icon buttons in the word list
      return btn.querySelector("svg") && btn.className.includes("h-8 w-8");
    });

    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(deleteWord).toHaveBeenCalledWith(1);
    });
  });

  // ── Search / filter ──

  it("filters words by search input", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "ephem" } });

    // Only ephemeral should be visible
    expect(screen.getByText("ephemeral")).toBeInTheDocument();
    expect(screen.queryByText("ubiquitous")).not.toBeInTheDocument();
    expect(screen.queryByText("resilience")).not.toBeInTheDocument();

    // Count should update (ephemeral matches, resilience does not)
    expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
  });

  it("filters words by level", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Click the TEM-4 filter button (in the filter bar, not the per-word level buttons)
    const filterButtons = screen.getAllByRole("button", { name: "TEM-4" });
    fireEvent.click(filterButtons[0]);

    // Only ubiquitous (TEM-4) should be visible in the filtered list
    expect(screen.queryByText("ephemeral")).not.toBeInTheDocument();
    expect(screen.getByText("ubiquitous")).toBeInTheDocument();
    expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();
  });

  it("clears level filter when clicking the same level again", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Apply CET-6 filter
    const cet6Buttons = screen.getAllByRole("button", { name: "CET-6" });
    fireEvent.click(cet6Buttons[0]);

    expect(screen.getByText(/共 1 个单词/)).toBeInTheDocument();

    // Click CET-6 again to clear filter
    fireEvent.click(cet6Buttons[0]);

    expect(screen.getByText(/共 3 个单词/)).toBeInTheDocument();
  });

  it("shows no-match message when search has no results", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockResolvedValueOnce(sampleWords);

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/搜索单词/);
    fireEvent.change(searchInput, { target: { value: "xyznotfound" } });

    expect(screen.getByText(/没有匹配的单词/)).toBeInTheDocument();
  });

  // ── Error handling ──

  it("shows error banner on load failure", async () => {
    const { getWords } = await import("@/lib/db");
    vi.mocked(getWords).mockRejectedValueOnce(new Error("数据库连接失败"));

    renderVocabularyPage();

    await waitFor(() => {
      expect(screen.getByText(/数据库连接失败/)).toBeInTheDocument();
    });
  });

  // ── Manual add form ──

  it("toggles manual add form open/closed", async () => {
    renderVocabularyPage();

    // The form header (CardTitle) should be clickable
    const formHeaders = screen.getAllByText("手动添加");
    expect(formHeaders.length).toBeGreaterThanOrEqual(1);
    const formHeader = formHeaders[0];

    // Form inputs should not be visible initially
    expect(screen.queryByPlaceholderText(/输入英文单词/)).not.toBeInTheDocument();

    // Click to open
    fireEvent.click(formHeader);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/输入英文单词/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/fəˈnetɪk/)).toBeInTheDocument();
    });

    // Click again to close
    fireEvent.click(formHeader);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/输入英文单词/)).not.toBeInTheDocument();
    });
  });

  // ── Navigation links ──

  it("renders 'start review' link to /review", async () => {
    renderVocabularyPage();

    const reviewLink = screen.getByText(/开始复习/).closest("a");
    expect(reviewLink).toHaveAttribute("href", "/review");
  });
});
