/**
 * @module PersistentRoutes
 * @description 持久化路由组件，让 CorrectPage 和 ReadingPage 在路由切换时保持挂载状态，
 * 避免用户的输入文本、LLM 流式请求等状态因卸载而丢失。
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router";

/**
 * 两个核心页面采用 lazy 懒加载：不进入主 bundle，首次访问对应持久化路径时才按需加载。
 * 挂载后保持常驻（通过 display 切换可见性），以保留页面内部状态。
 */
const CorrectPage = lazy(() => import("@/pages/CorrectPage"));
const ReadingPage = lazy(() => import("@/pages/ReadingPage"));

/**
 * 持久化页面路径的唯一权威定义（单一事实来源）。
 *
 * 此前 "/writing" / "/reading" 字面量在 Layout 的路由匹配器、页面内部等处重复出现，
 * 新增/移除持久化页面需要多处同步修改。现在统一从这里派生：
 * - Layout 的 ROUTE_MATCHERS（writing/reading 表项）
 * - 页面内部的“是否被隐藏”判定（useHiddenEffect + PERSISTENT_PAGE_PATHS.xxx）
 * 新增持久化页面时：在此登记路径 → 在下方接入对应组件 → 消费方自动跟随。
 */
export const PERSISTENT_PAGE_PATHS = {
  correct: "/writing",
  reading: "/reading",
} as const;

/** 需要持久化挂载的路由路径集合 */
export const PERSISTENT_PATHS: ReadonlySet<string> = new Set(Object.values(PERSISTENT_PAGE_PATHS));

/** 判断路径是否为持久化挂载的路由（非持久化路径走 <Outlet /> 正常渲染） */
export function isPersistentPath(pathname: string): boolean {
  return PERSISTENT_PATHS.has(pathname);
}

/**
 * 持久化路由组件
 *
 * 职责：让 CorrectPage（Writing Copilot，/writing）和 ReadingPage（Reading Copilot，/reading）
 * 在首次访问后保持挂载，而非路由切换时卸载/重新挂载。
 *
 * 为什么需要持久化？
 * 这两个核心页面有复杂的内部状态：
 * - 用户正在输入的文本
 * - 正在进行的 LLM 流式请求（streaming）
 * - 已经渲染的结果数据
 * - 知识图谱的 Cytoscape 实例
 * 如果路由切换时卸载组件，这些状态会全部丢失，用户体验很差。
 *
 * 延迟挂载语义：
 * 页面组件 lazy 懒加载（不进入主 bundle），且只有首次访问对应持久化路径时才挂载
 * （mounted 集合按 pathname 累积）。应用启动停留在 Dashboard 时，不会挂载任何页面树；
 * 一旦访问过某持久化路径，该页面便常驻渲染，仅通过 CSS `display` 切换可见性，
 * 从而在后续路由切换中保留内部状态。
 *
 * 实现方式：
 * - 每个持久化页面包裹 <Suspense fallback={null}>，懒加载 chunk 到达前不闪烁。
 * - 使用 CSS `display: contents` / `none` 切换可见性，而非条件渲染
 *   `display: contents` 让包裹 div 不产生任何布局框，等同于直接渲染子元素
 *   切换 display 不会触发组件的卸载/挂载生命周期
 * - 其他页面（生词本、历史记录等）通过 <Outlet /> 正常渲染
 *
 * 与 Layout 的关系：
 * 本组件作为 Layout 的子路由运行（见 App.tsx）：Layout 提供侧边栏与任务状态栏外壳，
 * 本组件只决定主内容区——持久化页面常驻显示，其余路由交给 <Outlet />。
 */
export function PersistentRoutes() {
  const { pathname } = useLocation();

  // 记录“已访问过”的持久化路径：首次命中某路径时才将对应页面加入渲染，
  // 加入后永久保留（常驻挂载），以维持状态不丢失。
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (isPersistentPath(pathname)) {
      setMounted((prev) => (prev.has(pathname) ? prev : new Set(prev).add(pathname)));
    }
  }, [pathname]);

  // 渲染期同步派生的有效挂载集合：首次访问持久化路径的那一帧 effect 尚未运行，
  // mounted 还不含当前路径，导致既不渲染对应页面也不渲染 <Outlet />，内容区闪一帧空白
  // （叠加 lazy chunk 加载更明显）。这里把"当前路径"在渲染期视为已挂载，消除首访闪烁；
  // 注意该派生集合只在渲染期用于判断，不能写回 state（否则每次渲染新建 Set 造成重渲染循环）。
  const effectiveMounted = useMemo(() => {
    if (!isPersistentPath(pathname)) return mounted;
    return mounted.has(pathname) ? mounted : new Set(mounted).add(pathname);
  }, [mounted, pathname]);

  return (
    <>
      {/*
       * 命中过 /writing 后始终挂载 CorrectPage，通过 display 控制可见性。
       * 注意：`display: contents` 在部分旧版浏览器中可能导致元素从无障碍树中消失，
       * 但 Tauri WebView2（Chromium 内核）不受影响。
       */}
      {effectiveMounted.has(PERSISTENT_PAGE_PATHS.correct) && (
        <div
          style={{
            display: pathname === PERSISTENT_PAGE_PATHS.correct ? "contents" : "none",
          }}
        >
          <Suspense fallback={null}>
            <CorrectPage />
          </Suspense>
        </div>
      )}
      {/*
       * 命中过 /reading 后始终挂载 ReadingPage，通过 display 控制可见性。
       */}
      {effectiveMounted.has(PERSISTENT_PAGE_PATHS.reading) && (
        <div
          style={{
            display: pathname === PERSISTENT_PAGE_PATHS.reading ? "contents" : "none",
          }}
        >
          <Suspense fallback={null}>
            <ReadingPage />
          </Suspense>
        </div>
      )}
      {/* 非持久化页面走正常的路由渲染 */}
      {!isPersistentPath(pathname) && <Outlet />}
    </>
  );
}
