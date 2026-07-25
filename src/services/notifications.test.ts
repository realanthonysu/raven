import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri notification plugin
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

// Mock db module
vi.mock("@/lib/db", () => ({
  getReviewStats: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { getReviewStats, getSetting, setSetting } from "@/lib/db";
import {
  checkAndNotifyReview,
  getNotificationPermission,
  requestNotificationPermission,
} from "./notifications";

describe("checkAndNotifyReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all conditions pass
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "notification_enabled") return "true";
      if (key === "last_notification_date") return null;
      return null;
    });
    vi.mocked(getReviewStats).mockResolvedValue({
      total: 10,
      new_count: 5,
      learning_count: 3,
      mastered_count: 2,
      dueCount: 5,
    });
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(setSetting).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends notification when all conditions pass", async () => {
    await checkAndNotifyReview();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(setSetting).toHaveBeenCalledWith(
      "last_notification_date",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("does not send when notification is disabled", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "notification_enabled") return "false";
      return null;
    });
    await checkAndNotifyReview();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not send when already notified today", async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "notification_enabled") return "true";
      if (key === "last_notification_date") return today;
      return null;
    });
    await checkAndNotifyReview();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not send when no words are due", async () => {
    vi.mocked(getReviewStats).mockResolvedValue({
      total: 10,
      new_count: 5,
      learning_count: 3,
      mastered_count: 2,
      dueCount: 0,
    });
    await checkAndNotifyReview();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission if not granted", async () => {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("granted" as NotificationPermission);
    await checkAndNotifyReview();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("does not send when permission is denied", async () => {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied" as NotificationPermission);
    await checkAndNotifyReview();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("silently catches errors", async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error("DB error"));
    await expect(checkAndNotifyReview()).resolves.not.toThrow();
  });
});

describe("getNotificationPermission", () => {
  it("returns 'granted' when permission is granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    expect(await getNotificationPermission()).toBe("granted");
  });

  it("returns 'default' when permission is not granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    expect(await getNotificationPermission()).toBe("default");
  });

  it("returns 'default' on error", async () => {
    vi.mocked(isPermissionGranted).mockRejectedValue(new Error("plugin error"));
    expect(await getNotificationPermission()).toBe("default");
  });
});

describe("requestNotificationPermission", () => {
  it("delegates to Tauri requestPermission", async () => {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    vi.mocked(requestPermission).mockResolvedValue("granted" as NotificationPermission);
    const result = await requestNotificationPermission();
    expect(result).toBe("granted");
  });
});
