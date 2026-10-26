import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCard } from "./ReviewCard";

// key 拼写由 settings-keys 契约测试锁定；此处 mock 页面实际消费的
// 类型化 wrapper（getFsrsRequestRetention/setFsrsRequestRetention）
vi.mock("@/lib/db", () => ({
  getFsrsRequestRetention: vi.fn().mockResolvedValue(null),
  setFsrsRequestRetention: vi.fn().mockResolvedValue(undefined),
}));

import { getFsrsRequestRetention, setFsrsRequestRetention } from "@/lib/db";

describe("ReviewCard", () => {
  const onError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFsrsRequestRetention).mockResolvedValue(null);
    vi.mocked(setFsrsRequestRetention).mockResolvedValue(undefined);
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
    vi.mocked(getFsrsRequestRetention).mockResolvedValue("0.95");
    render(<ReviewCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/适合备考冲刺/)).toBeInTheDocument();
    });
    expect(getFsrsRequestRetention).toHaveBeenCalled();
  });

  it("saves the selected preset via setFsrsRequestRetention", async () => {
    render(<ReviewCard onError={onError} />);
    fireEvent.click(screen.getByText("轻松"));
    await waitFor(() => {
      expect(setFsrsRequestRetention).toHaveBeenCalledWith("0.8");
    });
    expect(screen.getByText(/适合休闲学习/)).toBeInTheDocument();
  });

  it("rolls back selection and reports error when save fails", async () => {
    vi.mocked(setFsrsRequestRetention).mockRejectedValue(new Error("db error"));
    render(<ReviewCard onError={onError} />);
    fireEvent.click(screen.getByText("强化"));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("更新复习设置失败"));
    });
    // 回滚到默认标准档
    expect(screen.getByText(/复习量与记忆效果均衡/)).toBeInTheDocument();
  });

  it("shows custom retention hint for non-preset values", async () => {
    vi.mocked(getFsrsRequestRetention).mockResolvedValue("0.85");
    render(<ReviewCard onError={onError} />);
    await waitFor(() => {
      expect(screen.getByText(/自定义留存率 0.85/)).toBeInTheDocument();
    });
  });
});
