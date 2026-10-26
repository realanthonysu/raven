/**
 * createExternalStore —— useSyncExternalStore 微 store 的公共管道工厂。
 *
 * task-status 与 use-proficiency-level 是全仓仅有的两个外部 store module，
 * listeners 管理 / emitChange / subscribe / 快照接线五件套此前逐字手抄两份；
 * 本工厂把这段纯管道收拢为一份，各模块只保留自己的领域策略
 * （task-status 的三态守卫、级别 store 的水合一次 + 手动设置优先）。
 *
 * set 的约定：updater 返回**原引用**时视为 no-op —— 不通知订阅者并返回 false。
 * 「同值不 emit」（避免无谓重渲染）由各模块在 updater 里用返回原引用表达。
 */
import { useSyncExternalStore } from "react";

export interface ExternalStore<T> {
  /** useSyncExternalStore 要求的 subscribe 签名；返回取消订阅函数 */
  subscribe: (cb: () => void) => () => void;
  /** useSyncExternalStore 要求的 getSnapshot 签名；必须返回同一引用（除非状态确实变化） */
  getSnapshot: () => T;
  /**
   * 写入新状态。updater 为函数时以当前快照调用；
   * 返回原引用 = no-op（不通知、返回 false），返回新引用 = 替换并通知（返回 true）。
   */
  set: (updater: T | ((prev: T) => T)) => boolean;
  /** React Hook —— 在组件中订阅本 store */
  useValue: () => T;
}

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let state = initial;
  let listeners: Array<() => void> = [];

  function emitChange() {
    for (const l of listeners) l();
  }

  function subscribe(cb: () => void) {
    listeners = [...listeners, cb];
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  }

  function getSnapshot(): T {
    return state;
  }

  function set(updater: T | ((prev: T) => T)): boolean {
    const next = typeof updater === "function" ? (updater as (prev: T) => T)(state) : updater;
    if (next === state) return false;
    state = next;
    emitChange();
    return true;
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, getSnapshot);
  }

  return { subscribe, getSnapshot, set, useValue };
}
