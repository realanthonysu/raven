import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDb, sampleReviewWords } from "@/test/mocks";

// ─── Module mocks ─────────────────────────────────────────────────

vi.mock("@/lib/db", () => mockDb);

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

vi.mock("@/hooks/use-audio-player", () => ({
  useAudioPlayer: () => ({
    playing: false,
    loading: false,
    toggle: vi.fn(),
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────

describe("ReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderReviewPage() {
    const { default: ReviewPage } = await import("./ReviewPage");
    return render(
      <MemoryRouter initialEntries={["/review"]}>
        <ReviewPage />
      </MemoryRouter>,
    );
  }

  it("shows stats dashboard on entry phase", async () => {
    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText(/待复习 5 个/)).toBeInTheDocument();
      expect(screen.getByText(/已掌握 2 个/)).toBeInTheDocument();
      expect(screen.getByText(/共 10 个词汇/)).toBeInTheDocument();
    });
  });

  it("shows 'start review' button when there are due words", async () => {
    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
  });

  it("shows 'no words to review' when dueCount is 0", async () => {
    mockDb.getReviewStats.mockResolvedValueOnce({
      total: 10,
      newCount: 0,
      learningCount: 2,
      masteredCount: 8,
      dueCount: 0,
    });

    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText(/暂无待复习的词汇/)).toBeInTheDocument();
      expect(screen.getByText(/返回生词本/)).toBeInTheDocument();
    });
  });

  it("transitions to reviewing phase when 'start review' is clicked", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    // Wait for stats to load
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });

    // Click start review
    fireEvent.click(screen.getByText("开始复习"));

    // Should show the first word
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
      expect(screen.getByText(/点击翻转查看释义/)).toBeInTheDocument();
    });
  });

  it("flips card on click to show definition", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    // Start review
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Wait for the card to appear
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // The card should have the word visible but not the definition yet
    expect(screen.queryByText("短暂的，转瞬即逝的")).not.toBeInTheDocument();

    // Find and click the card (the one with the word)
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    // After flipping, definition should be visible
    await waitFor(() => {
      expect(screen.getByText("短暂的，转瞬即逝的")).toBeInTheDocument();
    });

    // Rating buttons should now be visible
    expect(screen.getByText("不认识")).toBeInTheDocument();
    expect(screen.getByText("模糊")).toBeInTheDocument();
    expect(screen.getByText("认识")).toBeInTheDocument();
  });

  it("rates a word as 'good' and moves to next word", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    // Start review
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Wait for first word
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Flip card
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    // Wait for rating buttons
    await waitFor(() => {
      expect(screen.getByText("认识")).toBeInTheDocument();
    });

    // Rate as "认识"
    fireEvent.click(screen.getByText("认识"));

    // Should move to second word
    await waitFor(() => {
      expect(screen.getByText("ubiquitous")).toBeInTheDocument();
    });

    // updateWordReview should have been called for the first word
    expect(mockDb.updateWordReview).toHaveBeenCalledWith(
      1, // word id
      expect.any(String), // status
      expect.any(Number), // reviewCount
      expect.any(String), // nextReviewAt
    );
  });

  it("rates a word as 'again' and records result", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    // Start review
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Wait for first word, flip it
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    await waitFor(() => {
      expect(screen.getByText("不认识")).toBeInTheDocument();
    });

    // Rate as "不认识"
    fireEvent.click(screen.getByText("不认识"));

    // Should move to second word
    await waitFor(() => {
      expect(screen.getByText("ubiquitous")).toBeInTheDocument();
    });

    // updateWordReview should be called with "learning" status and review_count=0
    expect(mockDb.updateWordReview).toHaveBeenCalledWith(1, "learning", 0, expect.any(String));
  });

  it("shows progress indicator during review", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Should show progress text "1 / 2"
    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });
  });

  it("transitions to done phase after all words are reviewed", async () => {
    // Only one word for simpler testing
    mockDb.getReviewWords.mockResolvedValueOnce([sampleReviewWords[0]]);
    mockDb.getReviewStats
      .mockResolvedValueOnce({
        total: 10,
        newCount: 5,
        learningCount: 3,
        masteredCount: 2,
        dueCount: 5,
      })
      .mockResolvedValueOnce({
        total: 10,
        newCount: 4,
        learningCount: 3,
        masteredCount: 3,
        dueCount: 4,
      });

    await renderReviewPage();

    // Start review
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Flip and rate
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    await waitFor(() => {
      expect(screen.getByText("认识")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("认识"));

    // Should transition to done phase
    await waitFor(() => {
      expect(screen.getByText(/本轮复习完成/)).toBeInTheDocument();
    });

    // Should show result counts
    expect(screen.getByText(/认识 1 个/)).toBeInTheDocument();
  });

  it("shows loading state while fetching review words", async () => {
    // Make getReviewWords return a never-resolving promise to capture loading state
    let resolveWords!: (value: typeof sampleReviewWords) => void;
    mockDb.getReviewWords.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWords = resolve;
      }),
    );

    await renderReviewPage();

    // Start review
    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    // Button text should change to "加载中..."
    await waitFor(() => {
      expect(screen.getByText("加载中...")).toBeInTheDocument();
    });

    // Resolve the words
    resolveWords(sampleReviewWords);

    // Now should show the first word
    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });
  });

  it("records learning activity after rating a word", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    await waitFor(() => {
      expect(screen.getByText("认识")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("认识"));

    await waitFor(() => {
      expect(mockDb.recordLearningActivity).toHaveBeenCalledWith("review");
    });
  });

  it("shows notes (collocations and example) when card is flipped", async () => {
    mockDb.getReviewWords.mockResolvedValueOnce(sampleReviewWords);

    await renderReviewPage();

    await waitFor(() => {
      expect(screen.getByText("开始复习")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("开始复习"));

    await waitFor(() => {
      expect(screen.getByText("ephemeral")).toBeInTheDocument();
    });

    // Flip card
    const cardElement = screen.getByText("ephemeral").closest("[class*='cursor-pointer']");
    if (cardElement) {
      fireEvent.click(cardElement);
    }

    // Should show collocations and example from the notes field
    await waitFor(() => {
      expect(screen.getByText(/ephemeral beauty/)).toBeInTheDocument();
      expect(screen.getByText(/Fame is ephemeral/)).toBeInTheDocument();
    });
  });
});
