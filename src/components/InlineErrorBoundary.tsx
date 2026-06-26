/**
 * @module InlineErrorBoundary
 * @description 内联错误边界组件，用于隔离页面中单个高风险区域（如知识图谱、TTS 播放区等）的崩溃，
 * 仅在父级布局中显示一个卡片级的错误提示，不会用全屏 fallback 覆盖整个应用。
 */

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** InlineErrorBoundary 组件的 Props 接口 */
interface InlineErrorBoundaryProps {
  /** 子组件树 */
  children: ReactNode;
  /** 可选的自定义降级 UI，省略时使用默认的错误提示卡片 */
  fallback?: ReactNode;
  /** 错误发生时的回调，可用于上报错误监控服务 */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  /** 区域名称，用于错误提示中标识出错的区域（如"知识图谱"） */
  sectionName?: string;
}

/** InlineErrorBoundary 组件的内部状态接口 */
interface InlineErrorBoundaryState {
  /** 是否捕获到错误 */
  hasError: boolean;
  /** 捕获到的错误对象，未出错时为 null */
  error: Error | null;
}

/**
 * 内联错误边界 — 用于隔离页面中单个高风险区域的崩溃。
 *
 * 与顶层 ErrorBoundary 不同，此组件仅占父级布局中的一个卡片区，
 * 不会用全屏 fallback 覆盖整个应用。
 *
 * 典型用途：
 * - KnowledgeGraph（Cytoscape.js 可能因图谱数据异常而崩溃）
 * - TTS 音频播放区域（WebAudio API 可能在特定环境下失败）
 * - LLM 结果解析/渲染区（JSON 格式不合规时 ReactMarkdown 等可抛错）
 * - ExerciseCard 渲染区（题型数据异常时组件可能崩溃）
 */
export class InlineErrorBoundary extends Component<
  InlineErrorBoundaryProps,
  InlineErrorBoundaryState
> {
  state: InlineErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // R12: 始终记录到 console 便于调试，即使未提供 onError 回调也不丢失错误信息
    console.error(
      `[InlineErrorBoundary${this.props.sectionName ? `: ${this.props.sectionName}` : ""}] Uncaught error:`,
      error,
      errorInfo.componentStack,
    );
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {this.props.sectionName ? `「${this.props.sectionName}」加载失败` : "该区域加载失败"}
            </p>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message || "发生未知错误"}
            </p>
          </div>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={this.handleRetry}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            重试
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
