/**
 * @module PersistentRoutes
 * @description 持久化路由组件，让 CorrectPage 和 ReadingPage 在路由切换时保持挂载状态，
 * 避免用户的输入文本、LLM 流式请求等状态因卸载而丢失。
 */

import { Outlet, useLocation } from "react-router-dom";
import CorrectPage from "@/pages/CorrectPage";
import ReadingPage from "@/pages/ReadingPage";

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
 * 在整个应用生命周期内保持挂载，而非路由切换时卸载/重新挂载。
 *
 * 为什么需要持久化？
 * 这两个核心页面有复杂的内部状态：
 * - 用户正在输入的文本
 * - 正在进行的 LLM 流式请求（streaming）
 * - 已经渲染的结果数据
 * - 知识图谱的 Cytoscape 实例
 * 如果路由切换时卸载组件，这些状态会全部丢失，用户体验很差。
 *
 * 实现方式：
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

  return (
    <>
      {/*
       * 始终挂载，通过 display 控制可见性。
       * 注意：`display: contents` 在部分旧版浏览器中可能导致元素从无障碍树中消失，
       * 但 Tauri WebView2（Chromium 内核）不受影响。
       */}
      <div style={{ display: pathname === PERSISTENT_PAGE_PATHS.correct ? "contents" : "none" }}>
        <CorrectPage />
      </div>
      <div style={{ display: pathname === PERSISTENT_PAGE_PATHS.reading ? "contents" : "none" }}>
        <ReadingPage />
      </div>
      {/* 非持久化页面走正常的路由渲染 */}
      {!isPersistentPath(pathname) && <Outlet />}
    </>
  );
}
