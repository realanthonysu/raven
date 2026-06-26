/**
 * @module ErrorBoundary
 * @description 应用顶层错误边界组件，捕获子组件树中未处理的 JavaScript 运行时错误，
 * 防止整个应用白屏崩溃并展示降级 UI。
 */

import { Component, type ReactNode } from "react";

/** ErrorBoundary 组件的 Props 接口 */
interface Props {
  /** 子组件树，通常是路由组件 */
  children: ReactNode;
}

/** ErrorBoundary 组件的内部状态接口 */
interface State {
  /** 是否捕获到错误 */
  hasError: boolean;
  /** 捕获到的错误对象，未出错时为 null */
  error: Error | null;
}

/**
 * 错误边界组件
 *
 * 职责：捕获子组件树中的 JavaScript 运行时错误，防止整个应用白屏崩溃。
 * 这是 React 官方推荐的错误处理机制，但只能用 Class 组件实现（截至 React 18）。
 *
 * 在 Raven 中的角色：
 * 作为 App.tsx 中路由的最外层包装，捕获任何未被页面组件自身处理的异常，
 * 比如 LLM 响应解析失败、Cytoscape 渲染错误等。
 *
 * 局限性：
 * - 不能捕获事件处理器中的错误（需用 try-catch）
 * - 不能捕获异步代码中的错误（setTimeout、Promise）
 * - 不能捕获服务端渲染错误
 * - 不能捕获 ErrorBoundary 自身抛出的错误
 *
 * 使用方式：在 App.tsx 中包裹路由组件：
 * ```tsx
 * <ErrorBoundary>
 *   <RouterProvider ... />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  /**
   * 静态方法：在渲染阶段捕获错误，更新 state 以触发降级 UI 渲染。
   * 这是 React 的生命周期方法，在子组件抛出错误后、重渲染前调用。
   */
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  /**
   * R12: 在提交阶段记录错误，用于调试和错误监控。
   *
   * 与 getDerivedStateFromError 的分工：
   * - getDerivedStateFromError（渲染阶段）：更新 state，不能有副作用
   * - componentDidCatch（提交阶段）：执行副作用，如日志记录
   *
   * errorInfo.componentStack 包含错误发生时的组件调用栈，
   * 能精确定位是哪个组件抛出的错误，对调试非常有价值。
   *
   * 后续若接入错误监控服务（如 Sentry），在此处添加上报逻辑即可。
   */
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center p-8">
          <div className="max-w-md space-y-4 text-center">
            <h1 className="text-2xl font-bold">出了点问题</h1>
            <p className="text-muted-foreground">
              {this.state.error?.message || "应用遇到了意外错误"}
            </p>
            {/* 重置错误状态并刷新页面，双保险确保应用恢复到干净状态 */}
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
