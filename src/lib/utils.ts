import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名的工具函数。
 *
 * 先通过 `clsx` 将多种输入格式（字符串、对象、数组、条件表达式）
 * 合并为单一字符串，再通过 `twMerge` 解决 Tailwind 类名冲突
 * （如 `p-2 p-4` 保留后者 `p-4`）。
 *
 * @param inputs - 任意数量的类名输入，支持 clsx 的所有格式
 * @returns 合并后的类名字符串
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 根据分数阈值返回对应的 Tailwind 颜色类名（绿/黄/红三级）。
 *
 * 统一 SpeakingPage 和 ListeningPage 中重复的分数颜色阈值逻辑。
 * 同时包含文字颜色和浅色背景变体，适配 light/dark 模式。
 *
 * @param value - 当前分数值
 * @param highThreshold - 高分阈值（≥ 此值为绿色）
 * @param lowThreshold - 低分阈值（≥ 此值为黄色，< 此值为红色）
 * @returns Tailwind 类名字符串
 */
export function getScoreColor(value: number, highThreshold: number, lowThreshold: number): string {
  if (value >= highThreshold) return "text-green-600 dark:text-green-400";
  if (value >= lowThreshold) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

/**
 * 根据分数阈值返回对应的背景颜色类名（绿/黄/红三级）。
 *
 * @param value - 当前分数值
 * @param highThreshold - 高分阈值
 * @param lowThreshold - 低分阈值
 * @returns Tailwind 背景色类名字符串
 */
export function getScoreBgColor(
  value: number,
  highThreshold: number,
  lowThreshold: number,
): string {
  if (value >= highThreshold) return "bg-green-500/10";
  if (value >= lowThreshold) return "bg-yellow-500/10";
  return "bg-red-500/10";
}
