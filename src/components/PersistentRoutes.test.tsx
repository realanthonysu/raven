import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  isPersistentPath,
  PERSISTENT_PAGE_PATHS,
  PERSISTENT_PATHS,
  PersistentRoutes,
} from "./PersistentRoutes";

vi.mock("@/pages/CorrectPage", () => ({ default: () => <div data-testid="correct-page" /> }));
vi.mock("@/pages/ReadingPage", () => ({ default: () => <div data-testid="reading-page" /> }));

/**
 * 渲染 PersistentRoutes。附带的导航链接用于模拟在持久化路径之间切换
 * （页面组件现在 lazy 加载，且首次访问对应路径后才挂载常驻）。
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <nav>
        <Link to="/writing">to-writing</Link>
        <Link to="/reading">to-reading</Link>
      </nav>
      <PersistentRoutes />
    </MemoryRouter>,
  );
}

describe("PersistentRoutes", () => {
  it("lazy-mounts CorrectPage on first visit to /writing", async () => {
    renderAt("/writing");
    expect(await screen.findByTestId("correct-page")).toBeInTheDocument();
  });

  it("lazy-mounts ReadingPage on first visit to /reading", async () => {
    renderAt("/reading");
    expect(await screen.findByTestId("reading-page")).toBeInTheDocument();
  });

  it("does not mount persistent pages on non-persistent routes before first visit", () => {
    renderAt("/vocabulary");
    // 从未访问过 /writing 或 /reading，两棵页面树都不应挂载
    expect(screen.queryByTestId("correct-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reading-page")).not.toBeInTheDocument();
  });

  /** 持久页外层 wrapper(display 切换发生在 parent div 上) */
  function wrapperOf(testId: string): HTMLElement {
    const el = screen.getByTestId(testId).parentElement;
    if (!el) throw new Error(`parent wrapper of ${testId} not found`);
    return el;
  }

  it("hides CorrectPage after navigating to /reading", async () => {
    renderAt("/writing");
    await screen.findByTestId("correct-page");
    fireEvent.click(screen.getByText("to-reading"));
    // ReadingPage 首次访问后懒加载挂载；CorrectPage 已常驻但被隐藏
    await screen.findByTestId("reading-page");
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "contents" });
  });

  it("hides ReadingPage after navigating to /writing", async () => {
    renderAt("/reading");
    await screen.findByTestId("reading-page");
    fireEvent.click(screen.getByText("to-writing"));
    // CorrectPage 首次访问后懒加载挂载；ReadingPage 已常驻但被隐藏
    await screen.findByTestId("correct-page");
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "contents" });
  });
});

// ─── 单源契约：PERSISTENT_PATHS / PERSISTENT_PAGE_PATHS / isPersistentPath ───
// Layout 的路由匹配器与页面内的隐藏检测都由此派生，这里锁死导出内容防止漂移。

describe("PersistentRoutes exported constants", () => {
  it("PERSISTENT_PATHS contains exactly the writing and reading routes", () => {
    expect(PERSISTENT_PATHS.has("/writing")).toBe(true);
    expect(PERSISTENT_PATHS.has("/reading")).toBe(true);
    expect(PERSISTENT_PATHS.size).toBe(2);
  });

  it("PERSISTENT_PATHS is derived from PERSISTENT_PAGE_PATHS", () => {
    expect([...PERSISTENT_PATHS]).toEqual(Object.values(PERSISTENT_PAGE_PATHS));
  });

  it("isPersistentPath matches persistent routes only", () => {
    expect(isPersistentPath("/writing")).toBe(true);
    expect(isPersistentPath("/reading")).toBe(true);
    // 非持久化路径（含动态参数路由与根路径）均不算
    expect(isPersistentPath("/vocabulary")).toBe(false);
    expect(isPersistentPath("/exercise/tense")).toBe(false);
    expect(isPersistentPath("/")).toBe(false);
  });
});
