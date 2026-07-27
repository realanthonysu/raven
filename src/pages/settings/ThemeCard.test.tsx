import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

const mockSetTheme = vi.fn();

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light",
    setTheme: mockSetTheme,
  }),
}));

import { ThemeCard } from "./ThemeCard";

function renderThemeCard() {
  return render(<ThemeCard />);
}

describe("ThemeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "外观" title', () => {
    renderThemeCard();
    expect(screen.getByText("外观")).toBeInTheDocument();
  });

  it("shows three theme buttons", () => {
    renderThemeCard();
    expect(screen.getByText("浅色")).toBeInTheDocument();
    expect(screen.getByText("深色")).toBeInTheDocument();
    expect(screen.getByText("跟随系统")).toBeInTheDocument();
  });

  it("calls setTheme when clicking a theme button", () => {
    renderThemeCard();
    fireEvent.click(screen.getByText("深色"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");

    fireEvent.click(screen.getByText("跟随系统"));
    expect(mockSetTheme).toHaveBeenCalledWith("system");

    fireEvent.click(screen.getByText("浅色"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });
});
