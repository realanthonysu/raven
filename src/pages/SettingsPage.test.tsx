import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all settings card sub-components
vi.mock("@/pages/settings", () => ({
  ThemeCard: () => <div data-testid="theme-card">ThemeCard</div>,
  ModelCard: ({ onError }: { onError: (msg: string) => void }) => (
    <div data-testid="model-card">
      ModelCard
      <button type="button" onClick={() => onError("model error")}>
        trigger error
      </button>
    </div>
  ),
  VoiceCard: ({ onError: _onError }: { onError: (msg: string) => void }) => (
    <div data-testid="voice-card">VoiceCard</div>
  ),
  GoalCard: ({ onError: _onError }: { onError: (msg: string) => void }) => (
    <div data-testid="goal-card">GoalCard</div>
  ),
  NotificationCard: ({ onError: _onError }: { onError: (msg: string) => void }) => (
    <div data-testid="notification-card">NotificationCard</div>
  ),
  ReviewCard: ({ onError: _onError }: { onError: (msg: string) => void }) => (
    <div data-testid="review-card">ReviewCard</div>
  ),
  BackupCard: ({ onError: _onError }: { onError: (msg: string) => void }) => (
    <div data-testid="backup-card">BackupCard</div>
  ),
  AboutCard: () => <div data-testid="about-card">AboutCard</div>,
}));

// Mock db module
vi.mock("@/lib/db", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getModels: vi.fn(),
}));

import SettingsPage from "./SettingsPage";

function renderSettings() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all 8 setting cards", () => {
    renderSettings();
    expect(screen.getByTestId("theme-card")).toBeInTheDocument();
    expect(screen.getByTestId("model-card")).toBeInTheDocument();
    expect(screen.getByTestId("voice-card")).toBeInTheDocument();
    expect(screen.getByTestId("goal-card")).toBeInTheDocument();
    expect(screen.getByTestId("review-card")).toBeInTheDocument();
    expect(screen.getByTestId("notification-card")).toBeInTheDocument();
    expect(screen.getByTestId("backup-card")).toBeInTheDocument();
    expect(screen.getByTestId("about-card")).toBeInTheDocument();
  });

  it("displays page title", () => {
    renderSettings();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("propagates error from child card to ErrorBanner", async () => {
    renderSettings();
    fireEvent.click(screen.getByText("trigger error"));
    expect(screen.getByText("model error")).toBeInTheDocument();
  });

  it("dismisses error on banner click", async () => {
    renderSettings();
    fireEvent.click(screen.getByText("trigger error"));
    expect(screen.getByText("model error")).toBeInTheDocument();
    // Dismiss — the ErrorBanner has a × button
    const dismissButton = screen.getByText("×");
    fireEvent.click(dismissButton);
    expect(screen.queryByText("model error")).not.toBeInTheDocument();
  });
});
