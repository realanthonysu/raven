/**
 * @module progress-bar
 * @description 可访问的进度条组件，支持平滑过渡动画和多种颜色变体。
 */

/** ProgressBar 组件的 Props 接口 */
interface ProgressBarProps {
  /** Current step (1-based) */
  current: number;
  /** Total number of steps */
  total: number;
  /** Optional label shown above the bar; defaults to "{current} / {total}" */
  label?: string;
  /** Show percentage text next to the label */
  showPercentage?: boolean;
  /** Color variant for the filled bar */
  variant?: "default" | "success" | "warning";
  className?: string;
}

const variantClasses: Record<NonNullable<ProgressBarProps["variant"]>, string> = {
  default: "bg-primary",
  success: "bg-green-600 dark:bg-green-500",
  warning: "bg-yellow-600 dark:bg-yellow-500",
};

/**
 * Accessible progress bar with smooth transition animation.
 *
 * @example
 * <ProgressBar current={3} total={5} />
 * <ProgressBar current={2} total={10} label="Step 2 of 10" variant="success" />
 */
export function ProgressBar({
  current,
  total,
  label,
  showPercentage = false,
  variant = "default",
  className,
}: ProgressBarProps) {
  // Guard against division by zero and clamp values
  const safeTotal = Math.max(total, 1);
  const safeCurrent = Math.min(Math.max(current, 0), safeTotal);
  const percentage = Math.round((safeCurrent / safeTotal) * 100);

  const barColor = variantClasses[variant];

  const displayLabel = label ?? `${safeCurrent} / ${safeTotal}`;
  const ariaLabel = `${displayLabel} — ${percentage}%`;

  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-valuenow={safeCurrent}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-label={ariaLabel}
        className="h-1.5 w-full rounded-full bg-secondary overflow-hidden"
      >
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground text-right mt-1">
        {displayLabel}
        {showPercentage && <span className="ml-1.5">({percentage}%)</span>}
      </p>
    </div>
  );
}
