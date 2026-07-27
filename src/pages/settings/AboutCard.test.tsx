import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.6.0"),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

import { getVersion } from "@tauri-apps/api/app";
import { AboutCard } from "./AboutCard";

function renderAboutCard() {
  return render(<AboutCard />);
}

describe("AboutCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVersion).mockResolvedValue("1.6.0");
  });

  it('renders "关于" title', () => {
    renderAboutCard();
    expect(screen.getByText("关于")).toBeInTheDocument();
  });

  it('shows "Raven" name', () => {
    renderAboutCard();
    expect(screen.getByText("Raven")).toBeInTheDocument();
  });

  it('shows "版本信息" button', () => {
    renderAboutCard();
    expect(screen.getByText("版本信息")).toBeInTheDocument();
  });

  it('opens dialog with version when clicking "版本信息"', async () => {
    renderAboutCard();

    fireEvent.click(screen.getByText("版本信息"));

    await waitFor(() => {
      expect(screen.getByText("关于 Raven")).toBeInTheDocument();
    });

    expect(screen.getByText("v1.6.0")).toBeInTheDocument();
    expect(screen.getByText("Tauri v2 + React 19")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
  });
});
