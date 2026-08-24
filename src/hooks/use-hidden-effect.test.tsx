/**
 * useHiddenEffect hook tests.
 *
 * 契约验证：仅在挂载期间 visible 由 true → false 转变时触发一次回调；
 * 首次挂载、重新显示、卸载均不触发。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHiddenEffect } from "./use-hidden-effect";

describe("useHiddenEffect", () => {
  it("does not fire on initial mount even when initial visible is false", () => {
    const onHidden = vi.fn();
    renderHook(() => useHiddenEffect(false, onHidden));

    expect(onHidden).not.toHaveBeenCalled();
  });

  it("does not fire on initial mount when initial visible is true", () => {
    const onHidden = vi.fn();
    renderHook(() => useHiddenEffect(true, onHidden));

    expect(onHidden).not.toHaveBeenCalled();
  });

  it("fires exactly once when visible transitions true -> false", () => {
    const onHidden = vi.fn();
    const { rerender } = renderHook(({ visible }) => useHiddenEffect(visible, onHidden), {
      initialProps: { visible: true },
    });

    rerender({ visible: false });

    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("does not fire on false -> true (re-show), but fires again on the next hide", () => {
    const onHidden = vi.fn();
    const { rerender } = renderHook(({ visible }) => useHiddenEffect(visible, onHidden), {
      initialProps: { visible: false },
    });

    // 隐藏态下重新显示：不触发
    rerender({ visible: true });
    expect(onHidden).not.toHaveBeenCalled();

    // 再次隐藏：触发一次
    rerender({ visible: false });
    expect(onHidden).toHaveBeenCalledTimes(1);

    // 相同值重复渲染（无转变）：不额外触发
    rerender({ visible: false });
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("fires once per true -> false transition across multiple toggles", () => {
    const onHidden = vi.fn();
    const { rerender } = renderHook(({ visible }) => useHiddenEffect(visible, onHidden), {
      initialProps: { visible: true },
    });

    rerender({ visible: false });
    rerender({ visible: true });
    rerender({ visible: false });
    rerender({ visible: true });
    rerender({ visible: false });

    expect(onHidden).toHaveBeenCalledTimes(3);
  });

  it("always invokes the latest callback reference without re-subscription", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ visible, cb }) => useHiddenEffect(visible, cb), {
      initialProps: { visible: true, cb: first },
    });

    // 注意：testing-library 的 rerender 是整体替换 props（非部分合并），cb 必须随传
    // 回调引用变化后发生隐藏：应调用最新引用
    rerender({ visible: true, cb: second });
    rerender({ visible: false, cb: second });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not fire on unmount while hidden", () => {
    const onHidden = vi.fn();
    const { rerender, unmount } = renderHook(({ visible }) => useHiddenEffect(visible, onHidden), {
      initialProps: { visible: true },
    });

    rerender({ visible: false });
    onHidden.mockClear();

    act(() => {
      unmount();
    });

    // 卸载是资源清理自己的职责，本 hook 不触发回调
    expect(onHidden).not.toHaveBeenCalled();
  });
});
