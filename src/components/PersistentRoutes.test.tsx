import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PersistentRoutes } from "./PersistentRoutes";

vi.mock("@/pages/CorrectPage", () => ({ default: () => <div data-testid="correct-page" /> }));
vi.mock("@/pages/ReadingPage", () => ({ default: () => <div data-testid="reading-page" /> }));

describe("PersistentRoutes", () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <PersistentRoutes />
      </MemoryRouter>,
    );
  }

  it("shows CorrectPage on /writing route", () => {
    renderAt("/writing");
    expect(screen.getByTestId("correct-page")).toBeInTheDocument();
  });

  it("shows ReadingPage on /reading route", () => {
    renderAt("/reading");
    expect(screen.getByTestId("reading-page")).toBeInTheDocument();
  });

  /** 持久页外层 wrapper(display 切换发生在 parent div 上) */
  function wrapperOf(testId: string): HTMLElement {
    const el = screen.getByTestId(testId).parentElement;
    if (!el) throw new Error(`parent wrapper of ${testId} not found`);
    return el;
  }

  it("hides CorrectPage on non-writing route", () => {
    renderAt("/reading");
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
  });

  it("hides ReadingPage on non-reading route", () => {
    renderAt("/writing");
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
  });

  it("renders Outlet for non-persistent routes", () => {
    renderAt("/vocabulary");
    // No persistent pages should be visible
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
  });
});
