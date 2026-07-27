/**
 * HistoryPage component-level tests.
 * Mocks db functions and react-router navigate.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HistoryPage from "./HistoryPage";

vi.mock("@/lib/db", () => ({
  getHistoryList: vi.fn().mockResolvedValue([]),
  deleteHistory: vi.fn().mockResolvedValue(undefined),
}));

describe("HistoryPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={["/history"]}>
        <Routes>
          <Route path="/history" element={<HistoryPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders page title", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /历史记录/ })).toBeInTheDocument();
  });

  it("shows empty state when no records", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/暂无历史记录/)).toBeInTheDocument();
    });
  });

  it("shows filter buttons", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /全部/ })).toBeInTheDocument();
    });
    // Filter labels come from typeConfig: Writing, Reading, Exercise, Listening, Speaking
    expect(screen.getByRole("button", { name: "Writing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reading" })).toBeInTheDocument();
  });

  it("renders records when data is loaded", async () => {
    const { getHistoryList } = await import("@/lib/db");
    vi.mocked(getHistoryList).mockResolvedValue([
      {
        id: 1,
        type: "correct",
        input_text: "Test input",
        result: "",
        graph_data: null,
        created_at: "2026-01-01",
      },
      {
        id: 2,
        type: "reading",
        input_text: "Reading text",
        result: "",
        graph_data: null,
        created_at: "2026-01-02",
      },
    ] as never);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Test input/)).toBeInTheDocument();
      expect(screen.getByText(/Reading text/)).toBeInTheDocument();
    });
  });

  it("can delete a record", async () => {
    const { getHistoryList, deleteHistory } = await import("@/lib/db");
    vi.mocked(getHistoryList).mockResolvedValue([
      {
        id: 1,
        type: "correct",
        input_text: "To delete",
        result: "",
        graph_data: null,
        created_at: "2026-01-01",
      },
    ] as never);
    vi.mocked(deleteHistory).mockResolvedValue(undefined);
    vi.mocked(getHistoryList)
      .mockResolvedValueOnce([
        {
          id: 1,
          type: "correct",
          input_text: "To delete",
          result: "",
          graph_data: null,
          created_at: "2026-01-01",
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/To delete/)).toBeInTheDocument();
    });

    // Click delete button (the Trash2 icon button)
    const deleteBtn = screen.getByRole("button", { name: "" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteHistory).toHaveBeenCalledWith(1);
    });
  });

  it("shows error banner on load failure", async () => {
    const { getHistoryList } = await import("@/lib/db");
    vi.mocked(getHistoryList).mockRejectedValue(new Error("DB error"));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/DB error/)).toBeInTheDocument();
    });
  });
});
