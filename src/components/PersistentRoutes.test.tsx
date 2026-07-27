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

  it("hides CorrectPage on non-writing route", () => {
    renderAt("/reading");
    const correctDiv = screen.getByTestId("correct-page").parentElement!;
    expect(correctDiv).toHaveStyle({ display: "none" });
  });

  it("hides ReadingPage on non-reading route", () => {
    renderAt("/writing");
    const readingDiv = screen.getByTestId("reading-page").parentElement!;
    expect(readingDiv).toHaveStyle({ display: "none" });
  });

  it("renders Outlet for non-persistent routes", () => {
    renderAt("/vocabulary");
    // No persistent pages should be visible
    const correctDiv = screen.getByTestId("correct-page").parentElement!;
    const readingDiv = screen.getByTestId("reading-page").parentElement!;
    expect(correctDiv).toHaveStyle({ display: "none" });
    expect(readingDiv).toHaveStyle({ display: "none" });
  });
});
