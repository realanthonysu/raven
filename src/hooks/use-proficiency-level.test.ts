/**
 * use-proficiency-level tests —— 全局英语水平级别 store。
 *
 * store 是模块级共享状态（current / manuallySet / hydrationStarted）：
 * 每个用例经 vi.resetModules + 动态 import 取全新模块实例，互不污染。
 * 覆盖：首次订阅水合、水合失败保持默认、手动设置优先于迟到水合、
 * 同值也落库（write-through 修复回归）、不同值 emit + 落库。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProficiencyLevel = vi.fn();
const mockSetProficiencyLevel = vi.fn();

vi.mock("@/lib/db/settings", () => ({
  getProficiencyLevel: (...args: unknown[]) => mockGetProficiencyLevel(...args),
  setProficiencyLevel: (...args: unknown[]) => mockSetProficiencyLevel(...args),
}));

/** 取一个全新的 store 模块实例（重置模块级水合/手动标记） */
async function freshStore() {
  vi.resetModules();
  return import("./use-proficiency-level");
}

describe("useProficiencyLevel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProficiencyLevel.mockResolvedValue("B1");
    mockSetProficiencyLevel.mockResolvedValue(undefined);
  });

  it("hydrates from settings on first subscribe and reflects the stored level", async () => {
    mockGetProficiencyLevel.mockResolvedValue("B2+");
    const { useProficiencyLevel } = await freshStore();

    const { result } = renderHook(() => useProficiencyLevel());
    // 水合完成前展示默认级别
    expect(result.current.level).toBe("B1");

    await waitFor(() => {
      expect(result.current.level).toBe("B2+");
    });
    // 水合本身只读不写
    expect(mockGetProficiencyLevel).toHaveBeenCalledTimes(1);
    expect(mockSetProficiencyLevel).not.toHaveBeenCalled();
  });

  it("keeps the default level when hydration fails", async () => {
    mockGetProficiencyLevel.mockRejectedValue(new Error("db fail"));
    const { useProficiencyLevel } = await freshStore();

    const { result } = renderHook(() => useProficiencyLevel());
    await waitFor(() => {
      expect(mockGetProficiencyLevel).toHaveBeenCalled();
    });

    expect(result.current.level).toBe("B1");
    expect(mockSetProficiencyLevel).not.toHaveBeenCalled();
  });

  it("persists even when the new level equals the current snapshot", async () => {
    // 修复回归：此前同值提前 return 会跳过落库——DB 写入曾失败时，
    // 之后每次设置同值都不会补救，UI 显示的级别重启后丢失
    const { useProficiencyLevel } = await freshStore();
    const { result } = renderHook(() => useProficiencyLevel());

    // 水合前 current=B1（默认）：同值设置也要落库
    act(() => {
      result.current.setLevel("B1");
    });

    expect(mockSetProficiencyLevel).toHaveBeenCalledWith("B1");
    expect(result.current.level).toBe("B1");
  });

  it("emits and persists when the level changes", async () => {
    const { useProficiencyLevel } = await freshStore();
    const { result } = renderHook(() => useProficiencyLevel());

    act(() => {
      result.current.setLevel("C1");
    });

    expect(mockSetProficiencyLevel).toHaveBeenCalledWith("C1");
    expect(result.current.level).toBe("C1");
  });

  it("manual set wins over a later hydration result", async () => {
    // 水合在途时手动设置：迟到水合不得覆盖手动值
    let resolveHydration!: (level: string) => void;
    mockGetProficiencyLevel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        }),
    );
    const { useProficiencyLevel } = await freshStore();
    const { result } = renderHook(() => useProficiencyLevel());

    act(() => {
      result.current.setLevel("A2");
    });
    expect(result.current.level).toBe("A2");
    expect(mockSetProficiencyLevel).toHaveBeenCalledWith("A2");

    // 迟到水合被手动设置标记挡下
    await act(async () => {
      resolveHydration("B2+");
    });
    expect(result.current.level).toBe("A2");
  });

  it("hydrates only once across re-renders", async () => {
    const { useProficiencyLevel } = await freshStore();
    const { rerender } = renderHook(() => useProficiencyLevel());
    rerender();
    rerender();

    await waitFor(() => {
      expect(mockGetProficiencyLevel).toHaveBeenCalledTimes(1);
    });
  });
});
