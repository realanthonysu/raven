/**
 * create-external-store tests —— useSyncExternalStore 微 store 工厂。
 *
 * 覆盖工厂自身的管道语义（通知/no-op/退订/hook 接线）；
 * 领域策略（三态守卫、水合）由 task-status / use-proficiency-level
 * 各自的测试覆盖。
 */
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createExternalStore } from "./create-external-store";

describe("createExternalStore", () => {
  it("set 新引用替换状态并通知订阅者；set 原引用为 no-op", () => {
    const store = createExternalStore<{ n: number }>({ n: 1 });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    expect(store.set((prev) => ({ ...prev, n: 2 }))).toBe(true);
    expect(store.getSnapshot()).toEqual({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);

    // 同值（返回原引用）：不通知
    expect(store.set((prev) => prev)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    // 直接传值形态：新引用通知、原引用 no-op
    expect(store.set({ n: 3 })).toBe(true);
    expect(store.set(store.getSnapshot())).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it("unsubscribe 后不再通知", () => {
    const store = createExternalStore<number>(0);
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    unsub();
    expect(store.set(1)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("useValue 在 React 组件中订阅并在变更时重渲染", () => {
    const store = createExternalStore<number>(0);
    let renders = 0;

    function Probe() {
      renders += 1;
      return <span>{store.useValue()}</span>;
    }

    const { getByText } = render(<Probe />);
    expect(getByText("0")).toBeInTheDocument();
    expect(renders).toBe(1);

    act(() => {
      store.set(1);
    });
    expect(getByText("1")).toBeInTheDocument();

    // no-op 不触发重渲染
    act(() => {
      store.set((prev) => prev);
    });
    expect(renders).toBe(2);
  });
});
