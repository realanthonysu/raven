import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCard } from "./ReviewCard";

vi.mock("@/lib/db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

import { getSetting, setSetting } from "@/lib/db";

describe("ReviewCard", () => {
  const onError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders review settings title and retention label", () => {
    render(<ReviewCard onError={onError} />);
    expect(screen.getByText("复习设置")).toBeInTheDocument();
    expect(screen.getByText("目标留存率")).toBeInTheDocument();
  });

  it("defaults to standard preset when no setting exists", async () => {
    render(<ReviewCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/复习量与记忆效果均衡/)).toBeInTheDocument();
    });
  });

  it("loads saved retention from settings on mount", async () => {
    vi.mocked(getSetting).mockResolvedValue("0.95");
    render(<ReviewCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/适合备考冲刺/)).toBeInTheDocument();
    });
    expect(getSetting).toHaveBeenCalledWith("fsrs_request_retention");
  });

  it("saves the selected preset via setSetting", async () => {
    render(<ReviewCard onError={onError} />);
    fireEvent.click(screen.getByText("轻松"));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith("fsrs_request_retention", "0.8");
    });
    expect(screen.getByText(/适合休闲学习/)).toBeInTheDocument();
  });

  it("rolls back selection and reports error when save fails", async () => {
    vi.mocked(setSetting).mockRejectedValue(new Error("db error"));
    render(<ReviewCard onError={onError} />);
    fireEvent.click(screen.getByText("强化"));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("更新复习设置失败"));
    });
    // 回滚到默认标准档
    expect(screen.getByText(/复习量与记忆效果均衡/)).toBeInTheDocument();
  });

  it("shows custom retention hint for non-preset values", async () => {
    vi.mocked(getSetting).mockResolvedValue("0.85");
    render(<ReviewCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/自定义留存率 0.85/)).toBeInTheDocument();
    });
  });
});
