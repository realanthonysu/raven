/**
 * @module Layout
 * @description 应用主布局模块，包含全局页面结构（侧边栏 + 主内容区）和后台任务状态栏组件。
 */

import { CheckCircle2, Loader2 } from "lucide-react";
import { Suspense, useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
import {
  clearTaskCompleted,
  TASK_DISPLAY_NAMES,
  TASK_KEYS,
  TASK_REGISTRY,
  type TaskKey,
  useTaskStatus,
} from "@/lib/task-status";
import { Sidebar } from "./Sidebar";

/**
 * 任务状态栏组件。
 *
 * 职责：在页面顶部显示后台 LLM 任务的运行/完成状态。
 * 支持五种任务类型：writing（写作批改）、reading（阅读精读）、exercise（弱项训练）、
 * listening（听力练习）、speaking（口语练习）。
 *
 * 设计原因：LLM 请求可能耗时较长（10-30 秒），用户在任务运行期间可能切换到其他页面，
 * 需要一个全局可见的状态提示，让用户知道后台任务仍在进行。
 *
 * 状态上报方：useStreamChat hook 是唯一写入者——setTaskStatus() / markTaskCompleted()
 * 均封装在该 hook 内（R9 起），各 LLM 页面不再自行上报；本组件只读取状态，
 * 并在用户导航到对应页面时清除 "completed" 状态。
 *
 * 状态清除策略：当用户导航到对应的任务页面时，自动清除 "completed" 状态，
 * 因为用户已经看到了结果，无需继续提示。exercise 使用 startsWith 匹配，
 * 因为其路由是 /exercise/:category（category 是动态参数）。
 */
function TaskStatusBar() {
  const taskStatus = useTaskStatus();
  const location = useLocation();

  // C4: 由 TASK_KEYS 派生,新增任务类型无需再改此处布尔组合
  const hasRunning = TASK_KEYS.some((k) => taskStatus[k] === "running");
  const hasCompleted = TASK_KEYS.some((k) => taskStatus[k] === "completed");

  /**
   * 路由变化时清除已完成状态。
   *
   * 首次渲染（挂载）时清除当前页面的 completed 状态（模拟"导航到此页面"）。
   * 后续渲染中，仅在 pathname 实际变化时清除，避免任务完成时
   * completed 状态在下一帧被立即清除（用户看不到绿色完成指示器）。
   *
   * 写作和阅读使用精确路径匹配（/writing 和 /reading），
   * 弱项训练使用前缀匹配（/exercise/:category），因为 category 是动态参数。
   * 只在当前状态为 "completed" 时才清除，避免覆盖正在进行的任务。
   */
  const prevPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    const isFirstRender = prevPathnameRef.current === null;
    const navigated = prevPathnameRef.current !== location.pathname;
    prevPathnameRef.current = location.pathname;

    // 首次渲染或实际导航时清除；已在页面上时 status 变化不清除
    if (!isFirstRender && !navigated) return;

    // 路径数据来自 TASK_REGISTRY（任务槽注册表，C6）——路由只声明一次；
    // 匹配方式留在本文件：writing/reading/listening/speaking 为精确匹配，
    // exercise 是 /exercise/:category 动态参数路由，需要前缀匹配。
    const ROUTE_MATCHERS: Record<TaskKey, (path: string) => boolean> = {
      writing: (p) => p === TASK_REGISTRY.writing.route,
      reading: (p) => p === TASK_REGISTRY.reading.route,
      exercise: (p) => p.startsWith(TASK_REGISTRY.exercise.route),
      listening: (p) => p === TASK_REGISTRY.listening.route,
      speaking: (p) => p === TASK_REGISTRY.speaking.route,
    };
    for (const key of TASK_KEYS) {
      if (taskStatus[key] === "completed" && ROUTE_MATCHERS[key](location.pathname)) {
        clearTaskCompleted(key);
      }
    }
  }, [location.pathname, taskStatus]);

  // 全部任务都空闲时不渲染任何内容，避免无意义的 DOM 节点
  if (!hasRunning && !hasCompleted) return null;

  /**
   * 构建运行中/已完成的任务名称列表。
   *
   * filter 谓词筛出状态匹配的任务键，再映射为展示名（TASK_DISPLAY_NAMES）。
   * 支持多任务同时运行（用户提交后快速切换页面再提交另一个）。
   */
  const runningTasks = TASK_KEYS.filter((k) => taskStatus[k] === "running").map(
    (k) => TASK_DISPLAY_NAMES[k],
  );

  const completedTasks = TASK_KEYS.filter((k) => taskStatus[k] === "completed").map(
    (k) => TASK_DISPLAY_NAMES[k],
  );

  return (
    <div className="border-b text-sm">
      {hasRunning && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{runningTasks.join(" + ")} 正在进行...</span>
        </div>
      )}
      {hasCompleted && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-green-500/10 text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>{completedTasks.join(" + ")} 已完成，请前往对应页面查看结果</span>
        </div>
      )}
    </div>
  );
}

/**
 * 应用主布局组件
 *
 * 职责：定义全局页面结构——左侧固定侧边栏 + 右侧可滚动主内容区。
 * 通过 react-router 的 <Outlet /> 渲染子路由页面。
 *
 * 布局策略：
 * - 使用 flex + h-screen 实现全屏布局，避免页面整体滚动
 * - main 区域设置 overflow-auto，让内容区独立滚动
 * - 内部再嵌套一层 flex-1 overflow-auto 的 div，确保 TaskStatusBar 固定在顶部
 *   不随内容滚动（StatusBar 在滚动容器外部）
 *
 * 与 PersistentRoutes 的关系：
 * PersistentRoutes 是 Layout 的子路由，经本组件的 <Outlet /> 渲染（见 App.tsx 路由配置）：
 * 本组件提供侧边栏与任务状态栏外壳；PersistentRoutes 决定主内容区——
 * CorrectPage/ReadingPage 常驻挂载（CSS display 切换可见性），其余路由交由其内部 <Outlet />。
 *
 * Suspense 边界归属（S-04）：
 * App 曾把整棵路由树包在一个顶层 <Suspense> 里，任一懒加载页面 chunk 未就绪时
 * 会把 Sidebar/TaskStatusBar 一起替换成全屏"加载中…"——启动首帧整壳迟到。
 * 现在边界下移到本组件的 <Outlet /> 外层：侧边栏与状态栏先渲染并可交互，
 * 只有主内容区显示占位。滚动容器（overflow-auto 的 div）留在边界外，
 * 页面切换时其滚动位置不会因 fallback 替换而丢。PersistentRoutes 的局部边界
 * 继续保留（常驻页首访时静默等待，不显示占位）。
 */
export function Layout() {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-auto">
        <TaskStatusBar />
        <div className="flex-1 overflow-auto">
          {/* 页面级懒加载的唯一边界：外壳（Sidebar/TaskStatusBar）始终先渲染 */}
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-muted-foreground">
                加载中…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
