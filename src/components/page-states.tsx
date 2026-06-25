import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 空状态引导组件：居中显示图标 + 标题 + 可选副标题。
 * 用于页面无数据且未加载时的引导提示。
 *
 * Usage:
 * <EmptyState icon={BookCheck} title="粘贴英文文本" subtitle="开始智能纠错" />
 */
interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  className?: string;
}

function EmptyState({ icon: Icon, title, subtitle, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-20 text-muted-foreground",
        className,
      )}
    >
      <Icon className="h-12 w-12 mb-4 opacity-30" />
      <p className="text-lg font-medium">{title}</p>
      {subtitle && <p className="text-sm mt-1">{subtitle}</p>}
    </div>
  );
}

/**
 * 错误提示横幅：红色边框 + 浅红背景。
 * 用于展示 LLM 调用失败、模型未配置等错误信息。
 *
 * Usage:
 * <ErrorBanner message="请先在设置页面配置 LLM 模型。" />
 */
interface ErrorBannerProps {
  message: string;
  className?: string;
  onDismiss?: () => void;
}

function ErrorBanner({ message, className, onDismiss }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400 flex items-start gap-2",
        className,
      )}
    >
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-red-400 hover:text-red-600 dark:text-red-300 dark:hover:text-red-100"
          aria-label="关闭"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * 警告提示横幅：amber 边框 + 浅 amber 背景。
 * 用于展示非阻断性警告（如历史记录保存失败），结果仍可展示但需告知用户。
 *
 * R9: 统一 ExercisePage/CorrectPage/ListeningPage/SpeakingPage/ReadingPage 中
 * 重复的 saveError/graphError 警告横幅 JSX。
 *
 * Usage:
 * <WarningBanner message={saveError} />
 */
interface WarningBannerProps {
  message: string;
  className?: string;
}

function WarningBanner({ message, className }: WarningBannerProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      {message}
    </div>
  );
}

/**
 * 加载指示器：旋转圆环 + 文本。
 * 用于 LLM 请求等待期间的加载占位。
 *
 * Usage:
 * <LoadingIndicator text="正在分析..." />
 * <LoadingIndicator text="正在检测语言..." className="h-24" />
 */
interface LoadingIndicatorProps {
  text?: string;
  className?: string;
}

function LoadingIndicator({ text = "加载中...", className }: LoadingIndicatorProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center h-16 text-muted-foreground text-sm",
        className,
      )}
    >
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent mr-2" />
      {text}
    </div>
  );
}

export { EmptyState, ErrorBanner, LoadingIndicator, WarningBanner };
