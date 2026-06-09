import { Outlet, useLocation } from "react-router-dom";
import CorrectPage from "@/pages/CorrectPage";
import ReadingPage from "@/pages/ReadingPage";

/** 需要持久化挂载的路由路径集合 */
const PERSISTENT_PATHS = new Set(["/writing", "/reading"]);

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
 * 当路由需要持久化页面时，用本组件替代 Layout 作为路由的 element。
 * 两者不同时使用——PersistentRoutes 自己处理主内容区，不需要 Layout 的 Outlet。
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
      <div style={{ display: pathname === "/writing" ? "contents" : "none" }}>
        <CorrectPage />
      </div>
      <div style={{ display: pathname === "/reading" ? "contents" : "none" }}>
        <ReadingPage />
      </div>
      {/* 非持久化页面走正常的路由渲染 */}
      {!PERSISTENT_PATHS.has(pathname) && <Outlet />}
    </>
  );
}
