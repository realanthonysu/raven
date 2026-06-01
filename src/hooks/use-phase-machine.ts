import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Configuration for phase transition callbacks.
 *
 * Both `onEnter` and `onExit` are partial maps — you only need to define
 * callbacks for the phases you care about.
 */
export type PhaseConfig<T extends string> = {
  /** Called after transitioning INTO a phase. */
  onEnter?: Partial<Record<T, () => void>>;
  /** Called before transitioning OUT OF a phase. */
  onExit?: Partial<Record<T, () => void>>;
};

/**
 * Generic phase-based state machine hook.
 *
 * Manages phase transitions with optional cleanup callbacks.
 * When transitioning to a new phase, runs the cleanup registered for the
 * previous phase (onExit), then the setup for the new phase (onEnter).
 *
 * @example
 * const { phase, transition, isPhase } = usePhaseMachine("loading", {
 *   onEnter: {
 *     loading: () => { resetErrors(); resetResults(); },
 *     answering: () => { /* no-op *\/ },
 *   },
 *   onExit: {
 *     loading: () => { /* cleanup timer *\/ },
 *   },
 * });
 *
 * transition("answering"); // runs onExit.loading, sets phase, runs onEnter.answering
 */
export function usePhaseMachine<T extends string>(
  initialPhase: T,
  config?: PhaseConfig<T>
): {
  phase: T;
  /** Transition to a new phase. Runs onExit for current, then onEnter for next. */
  transition: (next: T) => void;
  /** Convenience: phase === value */
  isPhase: (value: T) => boolean;
  /** Set phase directly without running callbacks (for error recovery). */
  setPhase: (next: T) => void;
} {
  const [phase, setPhaseState] = useState<T>(initialPhase);

  // Track current phase in a ref so transition() always reads the latest value
  // without needing phase in its useCallback dependency array.
  const phaseRef = useRef<T>(initialPhase);

  // Store config in a ref so callbacks can reference the latest config
  // without causing transition/setPhase to be recreated.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const transition = useCallback((next: T) => {
    const current = phaseRef.current;

    // Run onExit for the current phase before updating state.
    const exitCb = configRef.current?.onExit?.[current];
    if (exitCb) exitCb();

    // Update ref immediately so subsequent calls see the new phase.
    phaseRef.current = next;
    setPhaseState(next);

    // Run onEnter for the new phase after state update is queued.
    const enterCb = configRef.current?.onEnter?.[next];
    if (enterCb) enterCb();
  }, []);

  const setPhase = useCallback((next: T) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const isPhase = useCallback(
    (value: T) => phase === value,
    [phase]
  );

  return { phase, transition, isPhase, setPhase };
}
