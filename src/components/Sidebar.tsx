import { NavLink } from "react-router-dom";
import {
  Languages,
  BookCheck,
  BookOpen,
  Bookmark,
  History,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", icon: Languages, label: "翻译" },
  { to: "/correct", icon: BookCheck, label: "纠正" },
  { to: "/reading", icon: BookOpen, label: "精读" },
  { to: "/vocabulary", icon: Bookmark, label: "生词本" },
  { to: "/history", icon: History, label: "历史记录" },
  { to: "/settings", icon: Settings, label: "设置" },
];

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
    </aside>
  );
}
