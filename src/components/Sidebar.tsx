import { NavLink } from "react-router-dom";
import {
  BookCheck,
  BookOpen,
  Bookmark,
  Brain,
  History,
  BarChart3,
  Headphones,
  Gauge,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 导航菜单项配置
 *
 * 注意："/" 路由需要配合 NavLink 的 end 属性使用，
 * 否则所有以 "/" 开头的路径都会匹配到它。
 */
const navItems = [
  { to: "/", icon: BookCheck, label: "Writing Copilot" },
  { to: "/reading", icon: BookOpen, label: "Reading Copilot" },
  { to: "/vocabulary", icon: Bookmark, label: "生词本" },
  { to: "/review", icon: Brain, label: "复习" },
  { to: "/history", icon: History, label: "历史记录" },
  { to: "/analytics", icon: BarChart3, label: "学习分析" },
  { to: "/listening", icon: Headphones, label: "听力练习" },
  { to: "/speed-trainer", icon: Gauge, label: "语速训练" },
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
export function Sidebar() {
  return (
    <aside className="w-56 h-screen border-r bg-sidebar flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold tracking-tight">Raven</h1>
        <p className="text-xs text-muted-foreground">英语学习助手</p>
      </div>
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
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
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
                : "text-sidebar-foreground hover:bg-sidebar-accent/50"
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
