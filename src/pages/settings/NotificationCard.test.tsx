import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCard } from "./NotificationCard";

// key 拼写由 settings-keys 契约测试锁定；此处 mock 页面实际消费的
// 类型化 wrapper（读侧契约：只有显式 "false" 才关闭，默认 true）
vi.mock("@/lib/db", () => ({
  getNotificationEnabled: vi.fn().mockResolvedValue(true),
  setNotificationEnabled: vi.fn().mockResolvedValue(undefined),
  setLastNotificationDate: vi.fn().mockResolvedValue(undefined),
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
