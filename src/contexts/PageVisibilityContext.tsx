/**
 * PageVisibilityContext —— 持久化路由壳（PersistentRoutes）独占的「页面是否被隐藏」知识。
 *
 * 背景：CorrectPage/ReadingPage 常驻挂载、经 CSS display 切换可见性，永远等不到
 * unmount，需要 useHiddenEffect 在「被隐藏的瞬间」做清理（停止音频/朗读）。
 * 此前页面反向 import 路由壳的 PERSISTENT_PAGE_PATHS 并用 useLocation 自算
 * pathname === path —— 依赖方向倒置（叶子页面知道壳的内部常量）。现在壳经本
 * context 单向下发该知识，页面只问 usePageHidden("writing")。
 *
 * 判定规则：persistent 槽位 = 当前路由 ≠ 该槽位路由（被壳藏起）；非持久化槽位
 * 恒 false（壳从不隐藏它们——它们经 <Outlet /> 正常卸载，useHiddenEffect 的
 * 「卸载不触发」契约本就适用）。
 *
 * 默认值 () => false：壳外渲染（页面测试等独立挂载场景）= 永不被壳隐藏。
 * 需要「导航离开触发清理」语义的测试，用 PageVisibilityProvider 包住渲染树
 * （它经 useLocation 从路由取当前路径，与壳的判定同源）。
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { useLocation } from "react-router";
import { TASK_KEYS, TASK_REGISTRY, type TaskKey } from "@/lib/task-status";

const PageVisibilityContext = createContext<(taskKey: TaskKey) => boolean>(() => false);

/**
 * 可见性 Provider —— PersistentRoutes（或测试的 MemoryRouter 树）内使用。
 *
 * value 身份稳定性（P-05）：判定函数只依赖「当前命中的持久化路由」——
 * 在两个非持久化路径之间导航时该值为 null（身份不变），Provider 不换新函数，
 * 消费页面因此不会被每次导航无谓重渲；只有当持久化页面真正「显示 ↔ 隐藏」
 * 切换（离开/进入 /writing 或 /reading）时 value 才变化，useHiddenEffect
 * 才能在该转变点触发一次清理。派生规则与壳的 PERSISTENT_TASK_KEY 同源
 * （TASK_REGISTRY 的 persistent 行），非持久化路径恒为 null。
 */
export function PageVisibilityProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  /** 当前命中的持久化路由（非持久化路径 / 动态参数路由 → null） */
  const activePersistentRoute = useMemo(() => {
    for (const key of TASK_KEYS) {
      const meta = TASK_REGISTRY[key];
      if (meta.persistent && meta.route === pathname) return pathname;
    }
    return null;
  }, [pathname]);

  const isPageHidden = useCallback(
    (taskKey: TaskKey) => {
      const meta = TASK_REGISTRY[taskKey];
      return meta.persistent && meta.route !== activePersistentRoute;
    },
    [activePersistentRoute],
  );
  return (
    <PageVisibilityContext.Provider value={isPageHidden}>{children}</PageVisibilityContext.Provider>
  );
}

/**
 * 当前任务槽对应的页面是否被持久化路由壳隐藏。
 * 壳外渲染时恒为 false（见模块头注释）。
 */
export function usePageHidden(taskKey: TaskKey): boolean {
  return useContext(PageVisibilityContext)(taskKey);
}
