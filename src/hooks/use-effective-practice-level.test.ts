/**
 * use-effective-practice-level tests.
 *
 * 覆盖听力/口语两页共享的难度派生与定格语义：
 * - 默认跟随基准级别的「标准」档（含端点级别收缩为 2 项）；
 * - selectLevel 选择列表内级别后生效；
 * - selectLevel 列表外值（如水合前后基准级别变化）回落「标准」档；
 * - effectiveLevelRef 初始值等于 effectiveLevel，可手动赋值（定格语义）。
 *
 * useProficiencyLevel 经 mock 返回可变的固定级别，隔离全局 store 的 DB 水合。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LevelCode } from "@/lib/levels";
import { useEffectivePracticeLevel } from "./use-effective-practice-level";

// 可变的基准级别持有者：测试按需改写，模拟水合前后变化
const { mockLevel } = vi.hoisted(() => ({ mockLevel: { current: "B1" as LevelCode } }));
vi.mock("@/hooks/use-proficiency-level", () => ({
  useProficiencyLevel: () => ({ level: mockLevel.current, setLevel: vi.fn() }),
}));

describe("useEffectivePracticeLevel", () => {
  beforeEach(() => {
    mockLevel.current = "B1";
  });

  it("derives 低一档/标准/挑战 options from the base level", () => {
    // 基准 B1 → 派生 A2 / B1 / B1+ 三档
    const { result } = renderHook(() => useEffectivePracticeLevel());

    expect(result.current.levelOptions.map((o) => o.code)).toEqual(["A2", "B1", "B1+"]);
    expect(result.current.levelOptions.map((o) => o.hint)).toEqual(["低一档", "标准", "挑战"]);
  });

  it("follows the 标准 tier before any manual selection", () => {
    const { result } = renderHook(() => useEffectivePracticeLevel());
    expect(result.current.effectiveLevel).toBe("B1");
  });

  it("keeps the 标准 tier as default at the ladder endpoints (2 options)", () => {
    // C1 没有「挑战」档，端点收缩为 2 项
    mockLevel.current = "C1";
    const { result } = renderHook(() => useEffectivePracticeLevel());

    expect(result.current.levelOptions.map((o) => o.code)).toEqual(["B2+", "C1"]);
    expect(result.current.effectiveLevel).toBe("C1");
  });

  it("applies a selected level that is still in the options list", () => {
    const { result } = renderHook(() => useEffectivePracticeLevel());

    act(() => {
      result.current.selectLevel("B1+");
    });
    expect(result.current.effectiveLevel).toBe("B1+");
  });

  it("falls back to the 标准 tier when the base level change drops the selection out of the list", () => {
    // 模拟水合前后变化：先选 A2（基准 B1 时的低一档），基准水合为 B2 后
    // A2 不在新列表 [B1, B2, B2+]，回落新的标准档 B2
    const { result, rerender } = renderHook(() => useEffectivePracticeLevel());

    act(() => {
      result.current.selectLevel("A2");
    });
    expect(result.current.effectiveLevel).toBe("A2");

    mockLevel.current = "B2";
    rerender();
    expect(result.current.levelOptions.map((o) => o.code)).toEqual(["B1+", "B2", "B2+"]);
    expect(result.current.effectiveLevel).toBe("B2");
  });

  it("falls back to the 标准 tier when selecting a value outside the current options", () => {
    mockLevel.current = "B2";
    const { result } = renderHook(() => useEffectivePracticeLevel());

    // 直接选一个不在当前 options（[B1, B2, B2+]）的合法级别码
    act(() => {
      result.current.selectLevel("A2");
    });
    expect(result.current.effectiveLevel).toBe("B2");
  });

  it("initializes effectiveLevelRef to effectiveLevel and allows freezing it manually", () => {
    const { result } = renderHook(() => useEffectivePracticeLevel());

    // 定格语义：ref 初始值为当前有效级别，之后不随渲染自动更新
    expect(result.current.effectiveLevelRef.current).toBe("B1");

    // 页面在生成发起时显式写入 ref（手动赋值）
    act(() => {
      result.current.effectiveLevelRef.current = "A2";
    });
    expect(result.current.effectiveLevelRef.current).toBe("A2");

    // effectiveLevel 本身不受 ref 写入影响
    expect(result.current.effectiveLevel).toBe("B1");
  });
});
