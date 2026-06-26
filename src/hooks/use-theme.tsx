/**
 * 主题切换 Provider —— 支持 浅色 / 深色 / 跟随系统 三种模式。
 *
 * 实现要点：
 * - 通过在 `<html>` 上增删 `.dark` class 激活 Tailwind darkMode（见 tailwind.config.js `darkMode: ["class"]`）
 * - 主题偏好持久化到 localStorage（同步读取，避免 FOUC 闪烁）
 * - "跟随系统"模式下监听 `prefers-color-scheme` 变化实时切换
 * - KnowledgeGraph 等组件已读取 `.dark` class，无需额外适配
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** 用户选择的主题模式 */
  theme: Theme;
  /** 实际生效的主题（system 模式下解析为 light 或 dark） */
  resolvedTheme: ResolvedTheme;
  /** 切换主题，同时持久化到 localStorage */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "raven_theme";

/** 获取操作系统的主题偏好。 */
function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 将解析后的主题应用到 `<html>` 元素（增删 `.dark` class）。 */
function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    return saved ?? "system";
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved && saved !== "system") return saved;
    return getSystemTheme();
  });

  // 应用主题 class + 监听系统偏好变化（仅 system 模式）
  useEffect(() => {
    const resolved = theme === "system" ? getSystemTheme() : theme;
    setResolvedTheme(resolved);
    applyTheme(resolved);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const r = getSystemTheme();
      setResolvedTheme(r);
      applyTheme(r);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useMemo(
    () => (t: Theme) => {
      localStorage.setItem(STORAGE_KEY, t);
      setThemeState(t);
    },
    [],
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
