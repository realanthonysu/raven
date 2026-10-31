/**
 * App 启动壳测试（S-03）。
 *
 * 关注点：首次启动引导对话框改为 `lazy` 后——
 * 1. 检测逻辑不变：models 为空且 `onboarding_done` 未设置时才显示；
 * 2. 已完成引导的正常启动不加载/不渲染该对话框（懒加载 chunk 不被请求）；
 * 3. 完成引导时写入 `onboarding_done` 并卸载对话框。
 *
 * 路由树、GoalsProvider 与后台通知均以轻量替身接入——这些不是本测试对象，
 * 真实 Layout/PersistentRoutes 的 Suspense 归属由 Layout.test.tsx 覆盖。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModels, getOnboardingDone, setOnboardingDone } from "@/lib/db";
import App from "./App";

vi.mock("@/lib/db", () => ({
  getModels: vi.fn(),
  getOnboardingDone: vi.fn(),
  setOnboardingDone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/notifications", () => ({
  checkAndNotifyReview: vi.fn().mockResolvedValue(undefined),
}));

// 引导对话框：命名导出 + 可点击的"完成"按钮（验证回调接线与卸载）
vi.mock("@/components/OnboardingDialog", async () => {
  const { createElement } = await import("react");
  return {
    OnboardingDialog: ({ onComplete }: { onComplete: () => void }) =>
      createElement(
        "div",
        { "data-testid": "onboarding" },
        createElement("button", { type: "button", onClick: onComplete }, "完成引导"),
      ),
  };
});

vi.mock("./components/Layout", () => ({
  Layout: () => <div data-testid="layout-shell" />,
}));

vi.mock("./components/PersistentRoutes", () => ({
  PersistentRoutes: () => null,
}));

vi.mock("@/contexts/GoalsContext", () => ({
  GoalsProvider: ({ children }: { children: unknown }) => children,
}));

describe("App onboarding (S-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModels).mockResolvedValue([]);
    vi.mocked(getOnboardingDone).mockResolvedValue(false);
  });

  it("renders the app shell without waiting for the onboarding chunk", () => {
    render(<App />);
    // 外壳（Layout）首帧即渲染；引导检测是异步的，不阻塞首屏
    expect(screen.getByTestId("layout-shell")).toBeInTheDocument();
  });

  it("lazily shows the onboarding dialog on first launch", async () => {
    render(<App />);

    expect(await screen.findByTestId("onboarding")).toBeInTheDocument();
  });

  it("skips the onboarding dialog when a model is already configured", async () => {
    vi.mocked(getModels).mockResolvedValue([
      {
        id: 1,
        name: "default",
        api_key: "",
        base_url: "https://api.example.com/v1",
        model_name: "gpt-4o-mini",
        is_default: true,
      },
    ]);

    render(<App />);
    await waitFor(() => expect(getOnboardingDone).toHaveBeenCalled());

    // 已有模型 → 不渲染引导（懒加载 chunk 也就不会被请求）
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    expect(screen.getByTestId("layout-shell")).toBeInTheDocument();
  });

  it("skips the onboarding dialog when onboarding was already completed", async () => {
    vi.mocked(getModels).mockResolvedValue([]);
    vi.mocked(getOnboardingDone).mockResolvedValue(true);

    render(<App />);
    await waitFor(() => expect(getOnboardingDone).toHaveBeenCalled());

    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
  });

  it("persists onboarding_done and unmounts the dialog on completion", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("完成引导"));

    await waitFor(() => expect(setOnboardingDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument());
  });

  it("keeps the app usable when the first-launch check fails", async () => {
    // 检测失败不得阻塞启动：仅记录警告，外壳正常渲染、不显示引导
    vi.mocked(getModels).mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<App />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByTestId("layout-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();

    warn.mockRestore();
  });
});
