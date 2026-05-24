import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
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
