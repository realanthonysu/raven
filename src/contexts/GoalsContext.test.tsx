import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock 数据库层（GoalsContext 仅使用 getLearningGoals）
vi.mock("@/lib/db", () => ({
  getLearningGoals: vi.fn(),
}));

import { getLearningGoals } from "@/lib/db";
import { GoalsProvider, useGoals } from "./GoalsContext";

// ─── GoalsProvider / useGoals ───────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <GoalsProvider>{children}</GoalsProvider>;
}

describe("useGoals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLearningGoals).mockResolvedValue({});
  });

  it("throws when used outside GoalsProvider", () => {
    expect(() => renderHook(() => useGoals())).toThrow(
      "useGoals must be used within <GoalsProvider>",
    );
  });

  it("starts with an empty goals record before the db load resolves", () => {
    // 首帧：挂载加载尚未完成，恒为空 Record（与旧行为一致的冷启动首绘）
    const { result } = renderHook(() => useGoals(), { wrapper });

    expect(result.current.goals).toEqual({});
  });

  it("loads goals on mount via getLearningGoals (provider owns its lifecycle)", async () => {
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 30, listening: 15 });

    const { result } = renderHook(() => useGoals(), { wrapper });

    // 挂载后无需任何外部触发（此前必须等 Sidebar 首次导航写回）
    await waitFor(() => {
      expect(result.current.goals).toEqual({ reading: 30, listening: 15 });
    });
    expect(getLearningGoals).toHaveBeenCalledTimes(1);
  });

  it("stores the native Record shape from getLearningGoals without DTO conversion", async () => {
    vi.mocked(getLearningGoals).mockResolvedValue({ writing: 20 });

    const { result } = renderHook(() => useGoals(), { wrapper });

    await waitFor(() => {
      expect(result.current.goals).toEqual({ writing: 20 });
    });
  });

  it("refreshGoals reloads goals from db and preserves reference when content is unchanged", async () => {
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 30 });
    const { result } = renderHook(() => useGoals(), { wrapper });

    await waitFor(() => {
      expect(result.current.goals).toEqual({ reading: 30 });
    });
    const firstReference = result.current.goals;

    // 相同内容再次刷新：保持原引用（原 Sidebar 写回路径的内容相等守卫，现收拢到唯一写入点）
    await act(async () => {
      await result.current.refreshGoals();
    });
    expect(result.current.goals).toBe(firstReference);

    // 内容变化后才更新
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 45 });
    await act(async () => {
      await result.current.refreshGoals();
    });
    expect(result.current.goals).toEqual({ reading: 45 });
    expect(result.current.goals).not.toBe(firstReference);
  });

  it("refreshGoals warns and keeps previous goals when db call fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getLearningGoals).mockResolvedValue({ reading: 30 });
    const { result } = renderHook(() => useGoals(), { wrapper });

    await waitFor(() => {
      expect(result.current.goals).toEqual({ reading: 30 });
    });

    vi.mocked(getLearningGoals).mockRejectedValue(new Error("db down"));
    // 不应抛出异常，仅 console.warn（fail-soft，保留上次数据）
    await act(async () => {
      await result.current.refreshGoals();
    });

    expect(result.current.goals).toEqual({ reading: 30 });
    expect(warnSpy).toHaveBeenCalledWith("[GoalsContext] refreshGoals failed:", expect.any(Error));
  });

  it("mount load failure is fail-soft: warns and keeps empty record", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getLearningGoals).mockRejectedValue(new Error("db down"));

    const { result } = renderHook(() => useGoals(), { wrapper });

    // 挂载加载失败不崩溃、不向上抛错
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.goals).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith("[GoalsContext] refreshGoals failed:", expect.any(Error));
  });
});
