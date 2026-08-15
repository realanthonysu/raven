/**
 * Layout component tests.
 *
 * Strategy: mock Sidebar to avoid its deep dependency tree (GoalsContext, db, etc.),
 * mock task-status module to control TaskStatusBar rendering deterministically.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTaskCompleted } from "@/lib/task-status";
import { Layout } from "./Layout";

// Type the imported mock so we can call assertion methods on it
const mockClearTaskCompleted = vi.mocked(clearTaskCompleted);

// ─── Module mocks ─────────────────────────────────────────────────

// Mock Sidebar to avoid pulling in GoalsContext, db, router hooks, etc.
vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

// Mock task-status so TaskStatusBar can be tested in isolation.
// Use a module-level mutable object to control the return value per test.
let mockTaskStatus = {
  writing: "idle" as string,
  reading: "idle" as string,
  exercise: "idle" as string,
  listening: "idle" as string,
  speaking: "idle" as string,
};

vi.mock("@/lib/task-status", () => ({
  useTaskStatus: () => mockTaskStatus,
  clearTaskCompleted: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────

function resetTaskStatus() {
  mockTaskStatus = {
    writing: "idle",
    reading: "idle",
    exercise: "idle",
    listening: "idle",
    speaking: "idle",
  };
}

function renderLayout(route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Layout />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Layout", () => {
  afterEach(() => {
    resetTaskStatus();
    vi.clearAllMocks();
  });

  // ── Structure ──

  it("renders the layout structure with sidebar and main area", () => {
    renderLayout();

    // The layout root is a flex container with h-screen
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar).toBeInTheDocument();

    // The main content area should exist
    const main = document.querySelector("main");
    expect(main).toBeInTheDocument();
    expect(main).toHaveClass("flex-1");
  });

  // ── Sidebar ──

  it("renders the Sidebar component", () => {
    renderLayout();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  // ── Outlet ──

  it("renders outlet content inside the main area", () => {
    // Outlet renders child routes; MemoryRouter with a simple route proves this works
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Layout />
      </MemoryRouter>,
    );

    // The <main> tag should contain a div (the overflow-auto wrapper) with the Outlet
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    // Outlet renders nothing by default (no child routes), but the wrapper div should exist
    const scrollWrapper = main?.querySelector(".overflow-auto");
    expect(scrollWrapper).toBeInTheDocument();
  });

  // ── TaskStatusBar: no tasks ──

  it("does not show task status bar when all tasks are idle", () => {
    renderLayout();
    expect(screen.queryByText(/正在进行/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已完成/)).not.toBeInTheDocument();
  });

  // ── TaskStatusBar: running task ──

  it("shows running status when a writing task is running", () => {
    mockTaskStatus.writing = "running";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/Writing Copilot 纠正任务/)).toBeInTheDocument();
  });

  it("shows running status when a reading task is running", () => {
    mockTaskStatus.reading = "running";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/Reading Copilot 精读任务/)).toBeInTheDocument();
  });

  it("shows running status when an exercise task is running", () => {
    mockTaskStatus.exercise = "running";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/弱项训练任务/)).toBeInTheDocument();
  });

  it("shows running status when a listening task is running", () => {
    mockTaskStatus.listening = "running";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/听力练习任务/)).toBeInTheDocument();
  });

  it("shows running status when a speaking task is running", () => {
    mockTaskStatus.speaking = "running";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/口语练习任务/)).toBeInTheDocument();
  });

  // ── TaskStatusBar: completed task ──

  it("shows completed status when a writing task is completed", () => {
    mockTaskStatus.writing = "completed";
    renderLayout();

    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
    expect(screen.getByText(/Writing Copilot 纠正任务/)).toBeInTheDocument();
  });

  it("shows completed status when a reading task is completed", () => {
    mockTaskStatus.reading = "completed";
    renderLayout();

    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
    expect(screen.getByText(/Reading Copilot 精读任务/)).toBeInTheDocument();
  });

  it("shows completed status when an exercise task is completed", () => {
    mockTaskStatus.exercise = "completed";
    renderLayout();

    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
    expect(screen.getByText(/弱项训练任务/)).toBeInTheDocument();
  });

  it("shows completed status when a listening task is completed", () => {
    mockTaskStatus.listening = "completed";
    renderLayout();

    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
    expect(screen.getByText(/听力练习任务/)).toBeInTheDocument();
  });

  it("shows completed status when a speaking task is completed", () => {
    mockTaskStatus.speaking = "completed";
    renderLayout();

    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
    expect(screen.getByText(/口语练习任务/)).toBeInTheDocument();
  });

  // ── TaskStatusBar: multiple tasks ──

  it("shows multiple running tasks joined with +", () => {
    mockTaskStatus.writing = "running";
    mockTaskStatus.reading = "running";
    renderLayout();

    expect(
      screen.getByText(/Writing Copilot 纠正任务 \+ Reading Copilot 精读任务 正在进行/),
    ).toBeInTheDocument();
  });

  it("shows both running and completed sections independently", () => {
    mockTaskStatus.writing = "running";
    mockTaskStatus.reading = "completed";
    renderLayout();

    expect(screen.getByText(/正在进行/)).toBeInTheDocument();
    expect(screen.getByText(/已完成，请前往对应页面查看结果/)).toBeInTheDocument();
  });

  // ── TaskStatusBar: clear on navigation ──

  it("clears completed writing status when navigating to /writing", () => {
    mockTaskStatus.writing = "completed";
    renderLayout("/writing");

    expect(mockClearTaskCompleted).toHaveBeenCalledWith("writing");
  });

  it("clears completed reading status when navigating to /reading", () => {
    mockTaskStatus.reading = "completed";
    renderLayout("/reading");

    expect(mockClearTaskCompleted).toHaveBeenCalledWith("reading");
  });

  it("clears completed exercise status when navigating to /exercise", () => {
    mockTaskStatus.exercise = "completed";
    renderLayout("/exercise/tense");

    expect(mockClearTaskCompleted).toHaveBeenCalledWith("exercise");
  });

  it("clears completed listening status when navigating to /listening", () => {
    mockTaskStatus.listening = "completed";
    renderLayout("/listening");

    expect(mockClearTaskCompleted).toHaveBeenCalledWith("listening");
  });

  it("clears completed speaking status when navigating to /speaking", () => {
    mockTaskStatus.speaking = "completed";
    renderLayout("/speaking");

    expect(mockClearTaskCompleted).toHaveBeenCalledWith("speaking");
  });

  it("does not clear completed status when navigating to unrelated page", () => {
    mockTaskStatus.writing = "completed";
    renderLayout("/vocabulary");

    expect(mockClearTaskCompleted).not.toHaveBeenCalled();
  });
});
