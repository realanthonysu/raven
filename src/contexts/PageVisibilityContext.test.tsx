/**
 * PageVisibilityProvider 值稳定性与语义测试（P-05）。
 *
 * 契约：
 * - 持久化槽位：当前路由 ≠ 该槽位路由时隐藏；非持久化槽位恒不隐藏；
 * - value 身份只在「命中的持久化路由」变化时更新——在非持久化页面之间
 *   导航不会让消费页面重渲（此前每次导航都会换新函数）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageVisibilityProvider, usePageHidden } from "./PageVisibilityContext";

/** 记录 Probe 渲染次数：provider value 身份变化才会让它重渲 */
const probeRenderCount = vi.hoisted(() => ({ count: 0 }));

function Probe() {
  probeRenderCount.count += 1;
  const writingHidden = usePageHidden("writing");
  const readingHidden = usePageHidden("reading");
  const exerciseHidden = usePageHidden("exercise");
  return (
    <div data-testid="probe">
      {`writing:${writingHidden} reading:${readingHidden} exercise:${exerciseHidden}`}
    </div>
  );
}

function NavButton({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavButton to="/vocabulary" label="nav-vocabulary" />
      <NavButton to="/history" label="nav-history" />
      <NavButton to="/writing" label="nav-writing" />
      <NavButton to="/reading" label="nav-reading" />
      <PageVisibilityProvider>
        <Probe />
      </PageVisibilityProvider>
    </MemoryRouter>,
  );
}

describe("PageVisibilityProvider", () => {
  beforeEach(() => {
    probeRenderCount.count = 0;
  });

  it("marks only the active persistent page as visible", () => {
    renderAt("/writing");

    expect(screen.getByTestId("probe")).toHaveTextContent(
      "writing:false reading:true exercise:false",
    );
  });

  it("flips visibility when navigating between persistent pages", () => {
    renderAt("/writing");

    fireEvent.click(screen.getByText("nav-reading"));
    expect(screen.getByTestId("probe")).toHaveTextContent(
      "writing:true reading:false exercise:false",
    );
  });

  it("hides all persistent pages when on a non-persistent route", () => {
    renderAt("/vocabulary");

    expect(screen.getByTestId("probe")).toHaveTextContent(
      "writing:true reading:true exercise:false",
    );
  });

  it("keeps the provider value stable across non-persistent navigation", () => {
    renderAt("/vocabulary");
    const rendersAfterMount = probeRenderCount.count;

    // 两条非持久化路径之间导航：可见性判定完全一致，value 身份不应变化，
    // 消费页面（此处 Probe）不得因此重渲
    fireEvent.click(screen.getByText("nav-history"));
    expect(probeRenderCount.count).toBe(rendersAfterMount);
    expect(screen.getByTestId("probe")).toHaveTextContent(
      "writing:true reading:true exercise:false",
    );
  });

  it("re-renders consumers when the visibility actually changes", () => {
    renderAt("/vocabulary");
    const rendersAfterMount = probeRenderCount.count;

    fireEvent.click(screen.getByText("nav-writing"));
    expect(probeRenderCount.count).toBe(rendersAfterMount + 1);
    expect(screen.getByTestId("probe")).toHaveTextContent(
      "writing:false reading:true exercise:false",
    );
  });
});
