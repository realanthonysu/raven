import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { clearTaskCompleted, useTaskStatus } from "@/lib/task-status";
import { Sidebar } from "./Sidebar";

/**
 * 任务状态栏组件。
 *
 * 职责：在页面顶部显示后台 LLM 任务的运行/完成状态。
 * 支持四种任务类型：writing（写作批改）、reading（阅读精读）、exercise（弱项训练）、listening（听力练习）。
 *
 * 设计原因：LLM 请求可能耗时较长（10-30 秒），用户在任务运行期间可能切换到其他页面，
 * 需要一个全局可见的状态提示，让用户知道后台任务仍在进行。
 *
 * 状态上报方：各页面组件（CorrectPage、ReadingPage、ExercisePage）通过
 * setTaskStatus() / markTaskCompleted() 主动上报状态。
 *
 * 状态清除策略：当用户导航到对应的任务页面时，自动清除 "completed" 状态，
 * 因为用户已经看到了结果，无需继续提示。exercise 使用 startsWith 匹配，
 * 因为其路由是 /exercise/:category（category 是动态参数）。
 */
function TaskStatusBar() {
  const { writing, reading, exercise, listening, speaking } = useTaskStatus();
  const location = useLocation();

  // 任一任务处于 running 或 completed 状态时显示状态栏
  const hasRunning =
    writing === "running" ||
    reading === "running" ||
    exercise === "running" ||
    listening === "running" ||
    speaking === "running";
  const hasCompleted =
    writing === "completed" ||
    reading === "completed" ||
    exercise === "completed" ||
    listening === "completed" ||
    speaking === "completed";

  /**
   * 路由变化时清除已完成状态。
   *
   * 写作和阅读使用精确路径匹配（/writing 和 /reading），
   * 弱项训练使用前缀匹配（/exercise/:category），因为 category 是动态参数。
   * 只在当前状态为 "completed" 时才清除，避免覆盖正在进行的任务。
   */
  useEffect(() => {
    if (writing === "completed" && location.pathname === "/writing") {
      clearTaskCompleted("writing");
    }
    if (reading === "completed" && location.pathname === "/reading") {
      clearTaskCompleted("reading");
    }
    if (exercise === "completed" && location.pathname.startsWith("/exercise")) {
      clearTaskCompleted("exercise");
    }
    if (listening === "completed" && location.pathname === "/listening") {
      clearTaskCompleted("listening");
    }
    if (speaking === "completed" && location.pathname === "/speaking") {
      clearTaskCompleted("speaking");
    }
  }, [location.pathname, writing, reading, exercise, listening, speaking]);

  // 三个任务都空闲时不渲染任何内容，避免无意义的 DOM 节点
  if (!hasRunning && !hasCompleted) return null;

  /**
   * 构建运行中/已完成的任务名称列表。
   *
   * filter(Boolean) 过滤掉 false 值，只保留实际匹配的任务名称字符串。
   * 支持多任务同时运行（用户提交后快速切换页面再提交另一个）。
   */
  const runningTasks = [
    writing === "running" && "Writing Copilot 纠正任务",
    reading === "running" && "Reading Copilot 精读任务",
    exercise === "running" && "弱项训练任务",
    listening === "running" && "听力练习任务",
    speaking === "running" && "口语练习任务",
  ].filter(Boolean);

  const completedTasks = [
    writing === "completed" && "Writing Copilot 纠正任务",
    reading === "completed" && "Reading Copilot 精读任务",
    exercise === "completed" && "弱项训练任务",
    listening === "completed" && "听力练习任务",
    speaking === "completed" && "口语练习任务",
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
