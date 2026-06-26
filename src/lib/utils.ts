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
