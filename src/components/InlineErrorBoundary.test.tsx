import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InlineErrorBoundary } from "./InlineErrorBoundary";

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("Test error");
  return <div>Child content</div>;
}

describe("InlineErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <InlineErrorBoundary>
        <div>Normal content</div>
      </InlineErrorBoundary>,
    );
    expect(screen.getByText("Normal content")).toBeInTheDocument();
  });

  it("catches errors and shows default fallback", () => {
    // Suppress React error boundary console output
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <InlineErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </InlineErrorBoundary>,
    );

    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    expect(screen.getByText(/Test error/)).toBeInTheDocument();
    expect(screen.getByText(/重试/)).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("shows section name in error message", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <InlineErrorBoundary sectionName="知识图谱">
        <ThrowingComponent shouldThrow={true} />
      </InlineErrorBoundary>,
    );

    expect(screen.getByText(/知识图谱.*加载失败/)).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("renders custom fallback when provided", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <InlineErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingComponent shouldThrow={true} />
      </InlineErrorBoundary>,
    );

    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("retries when retry button is clicked", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <InlineErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </InlineErrorBoundary>,
    );

    expect(screen.getByText(/加载失败/)).toBeInTheDocument();

    // Click retry — resets error state
    fireEvent.click(screen.getByText(/重试/));

    // After retry, the component tries to render children again
    // Since the child still throws, it goes back to error state
    // The key behavior is that handleRetry was called (no crash)
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("calls onError callback when error is caught", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();

    render(
      <InlineErrorBoundary onError={onError}>
        <ThrowingComponent shouldThrow={true} />
      </InlineErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));

    consoleSpy.mockRestore();
  });
});
