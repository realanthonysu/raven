import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  isPersistentPath,
  PERSISTENT_PAGE_PATHS,
  PERSISTENT_PATHS,
  PersistentRoutes,
} from "./PersistentRoutes";

vi.mock("@/pages/CorrectPage", () => ({ default: () => <div data-testid="correct-page" /> }));
vi.mock("@/pages/ReadingPage", () => ({ default: () => <div data-testid="reading-page" /> }));

describe("PersistentRoutes", () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <PersistentRoutes />
      </MemoryRouter>,
    );
  }

  it("shows CorrectPage on /writing route", () => {
    renderAt("/writing");
    expect(screen.getByTestId("correct-page")).toBeInTheDocument();
  });

  it("shows ReadingPage on /reading route", () => {
    renderAt("/reading");
    expect(screen.getByTestId("reading-page")).toBeInTheDocument();
  });

  /** 持久页外层 wrapper(display 切换发生在 parent div 上) */
  function wrapperOf(testId: string): HTMLElement {
    const el = screen.getByTestId(testId).parentElement;
    if (!el) throw new Error(`parent wrapper of ${testId} not found`);
    return el;
  }

  it("hides CorrectPage on non-writing route", () => {
    renderAt("/reading");
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
  });

  it("hides ReadingPage on non-reading route", () => {
    renderAt("/writing");
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
  });

  it("renders Outlet for non-persistent routes", () => {
    renderAt("/vocabulary");
    // No persistent pages should be visible
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
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
