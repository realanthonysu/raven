import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useTaskStatus, clearTaskCompleted } from "@/lib/task-status";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useEffect } from "react";

/**
 * 任务状态栏组件
 *
 * 职责：在页面顶部显示后台 LLM 任务的运行/完成状态。
 * 设计原因：Writing Copilot 和 Reading Copilot 的 LLM 请求可能耗时较长，
 * 用户在任务运行期间可能切换到其他页面（如生词本），需要一个全局可见的状态提示。
 *
 * 状态清除策略：当用户导航到对应的任务页面时，自动清除 "completed" 状态，
 * 因为用户已经看到了结果，无需继续提示。这通过监听路由变化实现。
 */
function TaskStatusBar() {
  const { writing, reading } = useTaskStatus();
  const location = useLocation();

  const hasRunning = writing === "running" || reading === "running";
  const hasCompleted = writing === "completed" || reading === "completed";

  // 当用户导航回对应页面时清除完成状态，避免重复提示
  // 使用 pathname 精确匹配而非 includes，防止子路由误触发
  useEffect(() => {
    if (writing === "completed" && location.pathname === "/") {
      clearTaskCompleted("writing");
    }
    if (reading === "completed" && location.pathname === "/reading") {
      clearTaskCompleted("reading");
    }
  }, [location.pathname, writing, reading]);

  // 两个任务都空闲时不渲染任何内容，避免无意义的 DOM 节点
  if (!hasRunning && !hasCompleted) return null;

  // filter(Boolean) 过滤掉 false 值，只保留实际运行中的任务名称
  // 支持两个任务同时运行（用户提交后快速切换页面再提交另一个）
  const runningTasks = [
    writing === "running" && "Writing Copilot 纠正任务",
    reading === "running" && "Reading Copilot 精读任务",
  ].filter(Boolean);

  const completedTasks = [
    writing === "completed" && "Writing Copilot 纠正任务",
    reading === "completed" && "Reading Copilot 精读任务",
  ].filter(Boolean);

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
          <span>{completedTasks.join(" + ")} 已完成，点击查看结果</span>
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
 * 本组件是标准路由布局；PersistentRoutes 是专门用于 CorrectPage/ReadingPage
 * 的持久化挂载方案，两者互斥使用（见 App.tsx 路由配置）。
 */
export function Layout() {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-auto">
        <TaskStatusBar />
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
