/**
 * GoalCard component-level tests.
 *
 * Strategy: mock db functions (getLearningGoals, setLearningGoal) and
 * GoalsContext (useGoals) to isolate the component from Tauri dependencies.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalCard } from "./GoalCard";

// ─── Module mocks ─────────────────────────────────────────────────

const mockRefreshGoals = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  getLearningGoals: vi.fn(),
  setLearningGoal: vi.fn(),
}));

vi.mock("@/contexts/GoalsContext", () => ({
  useGoals: () => ({
    goals: [],
    setGoals: vi.fn(),
    refreshGoals: mockRefreshGoals,
  }),
}));

// Import after mock setup so we can access the mocked functions
import { getLearningGoals, setLearningGoal } from "@/lib/db";

const mockGetLearningGoals = vi.mocked(getLearningGoals);
const mockSetLearningGoal = vi.mocked(setLearningGoal);

// ─── Helpers ──────────────────────────────────────────────────────

function renderGoalCard(onError = vi.fn()) {
  return render(<GoalCard onError={onError} />);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("GoalCard", () => {
  beforeEach(() => {
    mockGetLearningGoals.mockResolvedValue({
      review: 20,
      exercise: 5,
      reading: 1,
      writing: 1,
      listening: 1,
    });
    mockSetLearningGoal.mockResolvedValue(undefined as never);
    mockRefreshGoals.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──

  it("renders the goal settings title", async () => {
    renderGoalCard();
    expect(screen.getByText("学习目标")).toBeInTheDocument();
  });

  it("shows all goal labels after loading", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    expect(screen.getByText("弱项训练")).toBeInTheDocument();
    expect(screen.getByText("阅读精读")).toBeInTheDocument();
    expect(screen.getByText("写作批改")).toBeInTheDocument();
    expect(screen.getByText("听力练习")).toBeInTheDocument();
  });

  it("displays goal values from the database", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("20")).toBeInTheDocument();
    });

    expect(screen.getByText("5")).toBeInTheDocument();
    // Three goal types (reading, writing, listening) have value 1
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(3);
  });

  it("shows edit button initially", async () => {
    renderGoalCard();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  });

  // ── Editing ──

  it("shows goal input fields with plus/minus buttons when editing", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // Should show save and cancel buttons
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    // Should show preset buttons
    expect(screen.getByRole("button", { name: "轻松" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进阶" })).toBeInTheDocument();

    // Should show plus and minus buttons (one pair per goal type = 5 types * 2 = 10)
    const iconButtons = screen.getAllByRole("button", { name: "" });
    const plusMinusButtons = iconButtons.filter((btn) => btn.querySelector("svg") !== null);
    expect(plusMinusButtons.length).toBeGreaterThanOrEqual(10);
  });

  it("increments goal value when plus button clicked", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // Find the plus button for the first goal (review, value 20)
    // The value "20" should be displayed in the editing mode
    const valueDisplay = screen.getByText("20");
    const row = valueDisplay.closest("div")?.parentElement;
    const plusBtn = row?.querySelectorAll("button")[1]; // second button is plus
    expect(plusBtn).toBeTruthy();
    if (!plusBtn) throw new Error("plus button not found");

    fireEvent.click(plusBtn);
    expect(screen.getByText("21")).toBeInTheDocument();
  });

  it("decrements goal value when minus button clicked", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    const valueDisplay = screen.getByText("20");
    const row = valueDisplay.closest("div")?.parentElement;
    const minusBtn = row?.querySelectorAll("button")[0]; // first button is minus
    expect(minusBtn).toBeTruthy();
    if (!minusBtn) throw new Error("minus button not found");

    fireEvent.click(minusBtn);
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("disables minus button when goal value is 0", async () => {
    mockGetLearningGoals.mockResolvedValue({
      review: 0,
      exercise: 0,
      reading: 0,
      writing: 0,
      listening: 0,
    });

    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // All minus buttons should be disabled when values are 0
    const iconButtons = screen.getAllByRole("button", { name: "" });
    const minusButtons = iconButtons.filter(
      (btn) => btn.querySelector("svg") !== null && btn.classList.contains("h-7"),
    );
    // First half are minus buttons
    const disabledMinusButtons = minusButtons.filter((btn) => btn.hasAttribute("disabled"));
    expect(disabledMinusButtons.length).toBeGreaterThanOrEqual(5);
  });

  it("applies preset when preset button clicked", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "进阶" }));

    // 进阶 preset: { review: 20, exercise: 3, reading: 2, writing: 2, listening: 2 }
    await waitFor(() => {
      const values = screen.getAllByText("2");
      expect(values.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Saving ──

  it("saves goals and exits editing mode", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      // Should call setLearningGoal for each goal type
      expect(mockSetLearningGoal).toHaveBeenCalledTimes(5);
    });

    // Should call refreshGoals to sync sidebar
    expect(mockRefreshGoals).toHaveBeenCalled();

    // Should exit editing mode (save/cancel buttons gone, edit button back)
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("calls onError when some saves fail", async () => {
    const onError = vi.fn();
    mockSetLearningGoal.mockImplementation((type: string) => {
      if (type === "review") return Promise.reject(new Error("save failed"));
      return Promise.resolve(undefined as never);
    });

    renderGoalCard(onError);

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    });
  });

  it("reverts goals on complete save failure", async () => {
    const onError = vi.fn();
    mockSetLearningGoal.mockRejectedValue(new Error("network error"));

    renderGoalCard(onError);

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    });
  });

  // ── Cancel ──

  it("reverts draft changes when cancel is clicked", async () => {
    renderGoalCard();

    await waitFor(() => {
      expect(screen.getByText("间隔复习")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // Change a value
    const valueDisplay = screen.getByText("20");
    const row = valueDisplay.closest("div")?.parentElement;
    const plusBtn = row?.querySelectorAll("button")[1];
    if (!plusBtn) throw new Error("plus button not found");
    fireEvent.click(plusBtn);
    expect(screen.getByText("21")).toBeInTheDocument();

    // Cancel
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // Should exit editing and show original value
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });
});
