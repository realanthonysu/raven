import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 阶段转换回调配置。
 *
 * `onEnter` 和 `onExit` 均为部分映射——只需为关心的阶段定义回调，
 * 未定义阶段将被忽略。
 */
export type PhaseConfig<T extends string> = {
  /** 进入某阶段后调用。 */
  onEnter?: Partial<Record<T, () => void>>;
  /** 离开某阶段前调用。 */
  onExit?: Partial<Record<T, () => void>>;
};

/**
 * 通用阶段状态机 hook。
 *
 * 管理阶段转换，支持可选的进入/离开回调。
 * 转换到新阶段时，先运行旧阶段的 onExit 清理回调，
 * 再运行新阶段的 onEnter 初始化回调。
 *
 * @example
 * const { phase, transition, isPhase } = usePhaseMachine("loading", {
 *   onEnter: {
 *     loading: () => { resetErrors(); resetResults(); },
 *     answering: () => { /* 无操作 *\/ },
 *   },
 *   onExit: {
 *     loading: () => { /* 清理定时器 *\/ },
 *   },
 * });
 *
 * transition("answering"); // 依次执行 onExit.loading → 更新 phase → onEnter.answering
 */
export function usePhaseMachine<T extends string>(
  initialPhase: T,
  config?: PhaseConfig<T>,
): {
  /** 当前所处的阶段 */
  phase: T;
  /** 转换到新阶段。依次执行当前阶段的 onExit 和新阶段的 onEnter。 */
  transition: (next: T) => void;
  /** 便捷方法：判断当前是否为指定阶段（phase === value） */
  isPhase: (value: T) => boolean;
  /** 直接设置阶段，不触发 onExit/onEnter 回调（用于错误恢复场景）。 */
  setPhase: (next: T) => void;
} {
  const [phase, setPhaseState] = useState<T>(initialPhase);

  // 将当前阶段存储在 ref 中，确保 transition() 始终读取最新值，
  // 而不需要将 phase 放入 useCallback 依赖数组（避免不必要的重建）。
  const phaseRef = useRef<T>(initialPhase);

  // 将 config 存储在 ref 中，使回调始终能引用最新的配置，
  // 同时避免 config 变化导致 transition/setPhase 被重新创建。
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const transition = useCallback((next: T) => {
    const current = phaseRef.current;
    if (current === next) return;

    // 先执行当前阶段的 onExit 回调，在更新 state 之前进行清理。
    const exitCb = configRef.current?.onExit?.[current];
    if (exitCb) exitCb();

    // 立即更新 ref，确保后续调用能看到新阶段（同步更新，不等 React 批量处理）。
    phaseRef.current = next;
    setPhaseState(next);

    // state 更新入队后，执行新阶段的 onEnter 回调。
    const enterCb = configRef.current?.onEnter?.[next];
    if (enterCb) enterCb();
  }, []);

  const setPhase = useCallback((next: T) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const isPhase = useCallback((value: T) => phaseRef.current === value, []);

  return { phase, transition, isPhase, setPhase };
}
