/**
 * useHiddenEffect —— 在 `visible` 从 true → false 转变（被隐藏）的那一刻精确触发一次回调。
 *
 * 契约：
 * - 仅在组件「保持挂载」期间 visible 由 true 变为 false 时调用 `onHidden`，
 *   每一段隐藏期恰好一次；false → true（重新显示）不触发；
 * - 首次挂载不触发（无论初始 visible 为 true 还是 false）；
 * - 卸载不触发——卸载清理是各资源自己的 unmount cleanup 的职责，与本 hook 无关。
 *
 * 为什么需要它：PersistentRoutes 用 CSS display 切换让 CorrectPage/ReadingPage
 * 常驻挂载（保留输入与流式状态），代价是页面永远等不到 unmount——用户离开页面时
 * 无法借助卸载清理做事。本 hook 补上"被隐藏的瞬间"这一时机
 * （例如停止朗读/播放中的音频），让持久化页面拥有与普通页面等价的离开语义。
 *
 * @param visible - 当前是否可见
 * @param onHidden - 可见→隐藏转变时执行的回调（无需 memoize，内部始终取最新引用）
 */
import { useEffect, useRef } from "react";
import { useLatestRef } from "@/hooks/use-latest-ref";

export function useHiddenEffect(visible: boolean, onHidden: () => void): void {
  // 上一帧的可见性：用 ref 而非 state，避免额外渲染
  const prevVisibleRef = useRef(visible);
  const onHiddenRef = useLatestRef(onHidden);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    // 首帧 wasVisible === visible（无论值为何）不触发；仅"可见→隐藏"转变触发
    if (wasVisible && !visible) {
      onHiddenRef.current();
    }
  }, [visible, onHiddenRef]);
}
