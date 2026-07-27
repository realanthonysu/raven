import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCard } from "./NotificationCard";

vi.mock("@/lib/db", () => ({
  getSetting: vi.fn().mockResolvedValue("true"),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/notifications", () => ({
  getNotificationPermission: vi.fn().mockResolvedValue("default" as NotificationPermission),
  requestNotificationPermission: vi.fn().mockResolvedValue("granted" as NotificationPermission),
}));

describe("NotificationCard", () => {
  const onError = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders notification settings title", () => {
    render(<NotificationCard onError={onError} />);
    expect(screen.getByText("通知设置")).toBeInTheDocument();
  });

  it("shows daily review reminder label", () => {
    render(<NotificationCard onError={onError} />);
    expect(screen.getByText(/每日复习提醒/)).toBeInTheDocument();
  });

  it("shows permission status", async () => {
    render(<NotificationCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/未请求/)).toBeInTheDocument();
    });
  });

  it("shows request permission button when permission is default", async () => {
    render(<NotificationCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/请求权限/)).toBeInTheDocument();
    });
  });
});
