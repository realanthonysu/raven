import { useRef } from "react";

/**
 * useLatestRef —— 将值存储在 ref 中并始终同步为最新值。
 *
 * 解决 useCallback 依赖数组中回调函数频繁变化导致函数重建的问题。
 * 常见场景：hook 接受 options 回调对象，将 options 存入 ref 后，
 * 核心函数的依赖数组无需包含 options，避免调用者未 memoize options
 * 时 execute/play 等函数被反复重建。
 *
 * 在 render 期间同步更新 ref（而非 useEffect），确保 ref.current 在同一渲染
 * 周期内即为最新值，避免 useEffect 延迟更新导致的 stale 窗口。React 允许
 * 在 render 期间写入 ref（当值来自 props/state 时），这是社区惯例。
 *
 * @param value - 需要保持最新引用的值
 * @returns 始终指向最新值的 ref
 *
 * @example
 * ```ts
 * const optionsRef = useLatestRef(options);
 * // 在 useCallback 中通过 optionsRef.current 访问，无需将 options 放入依赖数组
 * ```
 */
export function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
