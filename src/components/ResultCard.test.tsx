/**
 * ResultCard 折叠策略测试（P-04）。
 *
 * 两种折叠策略：
 * - 默认：条件渲染，折叠即卸载子树（短内容最优）；
 * - keepMounted：首次展开后持续挂载，折叠用 CSS（hidden 属性）隐藏，
 *   重型子树（Cytoscape / 长 Markdown）重新展开时不重建、不重解析。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { ResultCard } from "./ResultCard";

/** 计数挂载次数的重型子树替身：折叠后若被卸载，再次展开会重新触发 useEffect */
function MountProbe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <div>heavy-child</div>;
}

describe("ResultCard", () => {
  it("renders children by default (non-collapsible)", () => {
    render(<ResultCard title="分析结果">plain content</ResultCard>);

    expect(screen.getByText("分析结果")).toBeInTheDocument();
    expect(screen.getByText("plain content")).toBeVisible();
  });

  it("unmounts collapsed content by default (conditional rendering strategy)", () => {
    render(
      <ResultCard title="短内容" collapsible>
        short content
      </ResultCard>,
    );

    expect(screen.getByText("short content")).toBeInTheDocument();

    fireEvent.click(screen.getByText("短内容"));
    // 默认策略：折叠即卸载，DOM 中不再有内容节点
    expect(screen.queryByText("short content")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("短内容"));
    expect(screen.getByText("short content")).toBeInTheDocument();
  });

  it("does not mount keepMounted content before its first expansion", () => {
    const onMount = vi.fn();
    render(
      <ResultCard title="知识图谱" collapsible keepMounted defaultExpanded={false}>
        <MountProbe onMount={onMount} />
      </ResultCard>,
    );

    expect(screen.queryByText("heavy-child")).not.toBeInTheDocument();
    expect(onMount).not.toHaveBeenCalled();
  });

  it("keeps children mounted (CSS hidden) after first expand when keepMounted is set", () => {
    const onMount = vi.fn();
    render(
      <ResultCard title="知识图谱" collapsible keepMounted defaultExpanded={false}>
        <MountProbe onMount={onMount} />
      </ResultCard>,
    );

    // 首次展开：子树挂载
    fireEvent.click(screen.getByText("知识图谱"));
    expect(screen.getByText("heavy-child")).toBeVisible();
    expect(onMount).toHaveBeenCalledTimes(1);

    // 折叠：子树不卸载，只是被 CSS 隐藏
    fireEvent.click(screen.getByText("知识图谱"));
    expect(screen.getByText("heavy-child")).not.toBeVisible();
    expect(screen.getByText("heavy-child")).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(1);

    // 再次展开：仍是同一个挂载实例，不重建（Cytoscape 不重跑布局）
    fireEvent.click(screen.getByText("知识图谱"));
    expect(screen.getByText("heavy-child")).toBeVisible();
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("mounts keepMounted content immediately when defaultExpanded is true", () => {
    const onMount = vi.fn();
    render(
      <ResultCard title="参考翻译" collapsible keepMounted>
        <MountProbe onMount={onMount} />
      </ResultCard>,
    );

    expect(screen.getByText("heavy-child")).toBeVisible();
    expect(onMount).toHaveBeenCalledTimes(1);

    // 折叠仅隐藏：子树常驻（长 Markdown 不重解析）
    fireEvent.click(screen.getByText("参考翻译"));
    expect(screen.getByText("heavy-child")).not.toBeVisible();
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("toggles with keyboard and keeps aria-expanded in sync", () => {
    render(
      <ResultCard title="语法结构" collapsible keepMounted>
        syntax content
      </ResultCard>,
    );

    const header = screen.getByRole("button", { name: /语法结构/ });
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(header, { key: "Enter" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("syntax content")).not.toBeVisible();
  });
});
