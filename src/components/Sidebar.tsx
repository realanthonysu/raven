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
import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { getLearningGoals, getLearningStreak, getReviewStats, getTodayActivities } from "@/lib/db";
import { cn } from "@/lib/utils";

/**
 * 导航菜单项配置
 *
 * 注意："/" 路由需要配合 NavLink 的 end 属性使用，
 * 否则所有以 "/" 开头的路径都会匹配到它。
 */
const navItems = [
  { to: "/", icon: LayoutDashboard, label: "仪表盘" },
  { to: "/writing", icon: BookCheck, label: "写作助手" },
  { to: "/reading", icon: BookOpen, label: "阅读精读" },
  { to: "/listening", icon: Headphones, label: "听力练习" },
  { to: "/speaking", icon: Mic, label: "口语练习" },
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
  exercise: "练习",
  reading: "阅读",
  writing: "写作",
  listening: "听力",
  speaking: "口语",
};

export function Sidebar() {
  const [dueCount, setDueCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [goals, setGoals] = useState<Record<string, number>>({});
  const [todayActivities, setTodayActivities] = useState<Record<string, number>>({});
  const { pathname } = useLocation();
  const lastFetchRef = useRef(0);

  // Refetch sidebar data on navigation so badges/progress update after reviews/exercises
  // Debounce: skip if less than 2 seconds since last fetch
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch sidebar data on navigation
  useEffect(() => {
    const now = Date.now();
    if (now - lastFetchRef.current < 2000) return;
    lastFetchRef.current = now;

    let cancelled = false;
    Promise.all([
      getReviewStats(),
      getLearningStreak(),
      getLearningGoals(),
      getTodayActivities(),
    ]).then(([stats, s, g, activities]) => {
      if (!cancelled) {
        setDueCount(stats.dueCount);
        setStreak(s);
        setGoals(g);
        setTodayActivities(activities);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // 设置页保存学习目标后，Sidebar 需要同步刷新目标数值
  useEffect(() => {
    function handleGoalsChanged() {
      getLearningGoals().then(setGoals);
    }
    window.addEventListener("learning-goals-changed", handleGoalsChanged);
    return () => {
      window.removeEventListener("learning-goals-changed", handleGoalsChanged);
    };
  }, []);

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
                <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${percent >= 100 ? "bg-green-500" : "bg-primary"}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
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
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-medium">
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
