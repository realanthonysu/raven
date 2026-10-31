/**
 * @module Sidebar
 * @description 应用侧边栏导航组件，包含所有功能页面的入口、学习目标进度、连续学习天数和设置入口。
 */

import {
  BarChart3,
  BookCheck,
  Bookmark,
  BookOpen,
  Brain,
  Flame,
  Headphones,
  History,
  LayoutDashboard,
  Mic,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { ProgressBar } from "@/components/progress-bar";
import { useGoals } from "@/contexts/GoalsContext";
import { getSidebarData } from "@/lib/db";
import { TASK_KEYS, useTaskStatus } from "@/lib/task-status";
import { cn } from "@/lib/utils";

/**
 * 导航菜单项配置
 *
 * 注意："/" 路由需要配合 NavLink 的 end 属性使用，
 * 否则所有以 "/" 开头的路径都会匹配到它。
 */
const navItems = [
  { to: "/", icon: LayoutDashboard, label: "仪表盘" },
  { to: "/writing", icon: BookCheck, label: "写作训练" },
  { to: "/reading", icon: BookOpen, label: "阅读训练" },
  { to: "/listening", icon: Headphones, label: "听力训练" },
  { to: "/speaking", icon: Mic, label: "口语训练" },
  { to: "/vocabulary", icon: Bookmark, label: "生词本" },
  { to: "/review", icon: Brain, label: "复习" },
  { to: "/history", icon: History, label: "历史记录" },
  { to: "/analytics", icon: BarChart3, label: "学习分析" },
];

/**
 * 侧边栏导航组件
 *
 * 职责：提供应用的主导航，包含所有功能页面的入口和设置入口。
 *
 * 结构设计：
 * - 顶部：应用名称和副标题（品牌区）
 * - 中间：主导航菜单（flex-1 占据剩余空间）
 * - 底部：设置入口（用 border-t 分隔，视觉上独立于主菜单）
 *
 * NavLink 使用说明：
 * - NavLink 自动为当前激活的路由添加 isActive 状态
 * - 通过 className 回调函数根据 isActive 切换样式
 * - end 属性仅用于 "/" 路由，确保精确匹配
 *
 * 样式使用 shadcn/ui 的 CSS 变量（sidebar-accent 等），
 * 确保在亮色/暗色主题下都有正确的视觉表现。
 */
/** 学习目标标签（短版，适配 Sidebar 紧凑布局）。SettingsPage 使用长版标签。 */
const goalLabels: Record<string, string> = {
  review: "复习",
  exercise: "弱项练习",
  reading: "阅读",
  writing: "写作",
  listening: "听力",
  speaking: "口语",
};

export function Sidebar() {
  const [dueCount, setDueCount] = useState(0);
  const [streak, setStreak] = useState(0);
  // 纯读取方：目标数据由 GoalsProvider 挂载时自行加载（唯一生产者），
  // 本组件不再把 getSidebarData 的目标写回 context，也不做 Record↔Dto 转换
  const { goals, refreshGoals } = useGoals();
  const [todayActivities, setTodayActivities] = useState<Record<string, number>>({});
  const { pathname } = useLocation();
  const lastFetchRef = useRef(0);

  /** 统一的拉取入口：导航刷新与任务完成刷新共用。
   *  L-10: 使用聚合命令一次性获取 Sidebar 所需数据（原 4 次 IPC → 1 次）。
   *  D-07/S-05: getSidebarData 现在返回短 TTL（5s）共享快照——与 Dashboard、
   *  通知服务、GoalsProvider 共享同一次 db_get_sidebar_data IPC；
   *  打卡/目标写入会立即使其失效（lib/db/learning.ts）。
   *  内置 2s 防抖（lastFetchRef）：避免与导航刷新打架；任务完成触发的刷新
   *  会先重置 lastFetchRef 再走本函数，不会被防抖吞掉（自身仍受同一节流约束）。 */
  const fetchSidebarData = useCallback(() => {
    const now = Date.now();
    if (now - lastFetchRef.current < 2000) return;
    lastFetchRef.current = now;

    let cancelled = false;
    getSidebarData()
      .then(({ reviewStats, streak: s, goals: _sidebarGoals, todayActivities }) => {
        if (!cancelled) {
          setDueCount(reviewStats.dueCount);
          setStreak(s);
          // goals 字段刻意忽略（_sidebarGoals）：避免与 context 形成第二个写入路径，
          // 目标的加载/刷新完全由 GoalsContext 负责
          setTodayActivities(todayActivities);
        }
      })
      .catch((e) => {
        // 拉取失败不再静默：记录日志便于排查，UI 保持上次数据（不破坏侧边栏展示）
        console.error("[Sidebar] getSidebarData failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 导航时刷新（fetchSidebarData 为稳定 useCallback，刻意不列入依赖；
  // pathname 虽不在 effect 体内直接引用，但"导航即刷新"的触发条件就是它）
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch sidebar data on navigation
  useEffect(() => {
    return fetchSidebarData();
  }, [pathname]);

  /** 页内任务完成后也要刷新：原数据仅在 pathname 变化时拉取，用户停留在
   *  页面内完成任务（如写作纠正）时，连胜与今日目标计数不更新。
   *  订阅任务状态 store，completed 槽位数增加（有新任务完成）时延迟刷新。 */
  const taskStatus = useTaskStatus();
  const completedCount = TASK_KEYS.filter((key) => taskStatus[key] === "completed").length;
  const prevCompletedCountRef = useRef(completedCount);
  useEffect(() => {
    // 只响应"完成数增加"：完成态被页面挂载时清除（clearTaskCompleted）导致的
    // 计数减少不触发刷新，避免用户导航到任务页反而引发一次多余拉取
    if (completedCount <= prevCompletedCountRef.current) return;
    prevCompletedCountRef.current = completedCount;
    // 延迟约 2s：markTaskCompleted 先于 recordLearningActivity 落库，
    // 立即拉取会读到旧计数（活动数/连胜尚未写入）
    const timer = setTimeout(() => {
      // 重置防抖时间戳：完成触发的刷新可绕过 lastFetchRef 的 2s 窗口，
      // 避免刚因导航刷新过而被防抖吞掉；重置后仍走同一函数受其节流约束
      lastFetchRef.current = 0;
      fetchSidebarData();
      void refreshGoals();
    }, 2000);
    return () => clearTimeout(timer);
  }, [completedCount, fetchSidebarData, refreshGoals]);

  return (
    <aside className="w-56 h-screen border-r bg-sidebar flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold tracking-tight">Raven</h1>
        <p className="text-xs text-muted-foreground">英语学习助手</p>
      </div>
      {streak > 0 && (
        <div className="px-4 py-2 flex items-center gap-2 text-sm">
          <Flame className="h-4 w-4 text-orange-500" />
          <span className="text-muted-foreground">
            连续学习 <span className="font-semibold text-foreground">{streak}</span> 天
          </span>
        </div>
      )}
      {Object.keys(goals).length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">今日目标</p>
          {Object.entries(goals).map(([type, target]) => {
            const current = todayActivities[type] || 0;
            const percent = Math.min(100, Math.round((current / target) * 100));
            return (
              <div key={type} className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{goalLabels[type] || type}</span>
                  <span className={percent >= 100 ? "text-green-600" : "text-muted-foreground"}>
                    {current}/{target}
                  </span>
                </div>
                {/* C5: 复用 ProgressBar compact 变体,替代手写进度条 */}
                <ProgressBar
                  current={current}
                  total={target}
                  compact
                  variant={percent >= 100 ? "success" : "default"}
                />
              </div>
            );
          })}
        </div>
      )}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50",
              )
            }
          >
            <Icon className="h-4 w-4" />
            <span className="flex-1">{label}</span>
            {to === "/review" && dueCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-medium">
                {dueCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      {/* 设置入口独立放在底部，与主菜单视觉分隔 */}
      <div className="p-2 border-t">
        <NavLink
          to="/settings"
          end
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground hover:bg-sidebar-accent/50",
            )
          }
        >
          <Settings className="h-4 w-4" />
          设置
        </NavLink>
      </div>
    </aside>
  );
}
