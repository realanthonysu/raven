/**
 * KnowledgeGraph 节点选中信息栏交互测试。
 *
 * cytoscape 在 jsdom 下无法真实渲染 canvas，因此 mock 整个 cytoscape 模块，
 * 捕获 tap 事件处理器后手动触发，验证信息栏与"加入生词本"按钮的行为。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── cytoscape mock ──────────────────────────────────────────────────────────
// 记录 on() 注册的事件处理器，供测试手动触发
type TapHandler = (evt: { target: unknown }) => void;
const tapHandlers: { node: TapHandler[]; background: TapHandler[] } = {
  node: [],
  background: [],
};

// style() 返回可链式调用的对象（selector().style().update()）
const styleChain = {
  selector: () => styleChain,
  style: () => styleChain,
  update: vi.fn(),
};

const mockCy = {
  on: vi.fn((event: string, selectorOrHandler: string | TapHandler, maybeHandler?: TapHandler) => {
    if (event !== "tap") return;
    if (typeof selectorOrHandler === "string") {
      if (maybeHandler) tapHandlers.node.push(maybeHandler);
    } else {
      tapHandlers.background.push(selectorOrHandler);
    }
  }),
  nodes: vi.fn(() => []),
  style: vi.fn(() => styleChain),
  destroy: vi.fn(),
  resize: vi.fn(),
  fit: vi.fn(),
};

vi.mock("cytoscape", () => ({ default: vi.fn(() => mockCy) }));

import { KnowledgeGraph } from "./KnowledgeGraph";

const sampleData = {
  nodes: [
    { id: "n1", label: "光合作用", labelEn: "photosynthesis", type: "concept" },
    { id: "n2", label: "叶绿体", labelEn: null, type: "entity" },
  ],
  edges: [{ source: "n1", target: "n2", relation: "发生于" }],
};

/** 模拟点击图谱节点 */
function tapNode(id: string) {
  act(() => {
    for (const h of tapHandlers.node) h({ target: { id: () => id } });
  });
}

/** 模拟点击图谱空白区域（target 为 cy 实例本身） */
function tapBackground() {
  act(() => {
    for (const h of tapHandlers.background) h({ target: mockCy });
  });
}

describe("KnowledgeGraph node selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tapHandlers.node = [];
    tapHandlers.background = [];
  });

  it("shows info bar with labels after tapping a node", () => {
    render(<KnowledgeGraph data={sampleData} />);
    expect(screen.queryByText("光合作用")).not.toBeInTheDocument();

    tapNode("n1");
    expect(screen.getByText("光合作用")).toBeInTheDocument();
    expect(screen.getByText("photosynthesis")).toBeInTheDocument();
  });

  it("hides info bar when tapping background", () => {
    render(<KnowledgeGraph data={sampleData} />);
    tapNode("n1");
    expect(screen.getByText("光合作用")).toBeInTheDocument();

    tapBackground();
    expect(screen.queryByText("光合作用")).not.toBeInTheDocument();
  });

  it("calls onNodeClick with the tapped node id", () => {
    const onNodeClick = vi.fn();
    render(<KnowledgeGraph data={sampleData} onNodeClick={onNodeClick} />);
    tapNode("n1");
    expect(onNodeClick).toHaveBeenCalledWith("n1");
  });

  it("calls onAddWord with the English label when clicking add button", async () => {
    const onAddWord = vi.fn().mockResolvedValue(true);
    render(<KnowledgeGraph data={sampleData} onAddWord={onAddWord} addedWords={new Set()} />);
    tapNode("n1");

    const addButton = screen.getByRole("button", { name: /加入生词本/ });
    await act(async () => {
      fireEvent.click(addButton);
    });
    expect(onAddWord).toHaveBeenCalledWith("photosynthesis");
  });

  it("shows disabled added state when word is already in vocabulary", () => {
    const onAddWord = vi.fn();
    render(
      <KnowledgeGraph
        data={sampleData}
        onAddWord={onAddWord}
        addedWords={new Set(["photosynthesis"])}
      />,
    );
    tapNode("n1");

    const addedButton = screen.getByRole("button", { name: /已添加/ });
    expect(addedButton).toBeDisabled();
    expect(screen.queryByRole("button", { name: /加入生词本/ })).not.toBeInTheDocument();
  });

  it("hides add button for nodes without English label", () => {
    const onAddWord = vi.fn();
    render(<KnowledgeGraph data={sampleData} onAddWord={onAddWord} />);
    tapNode("n2");

    expect(screen.getByText("叶绿体")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加入生词本/ })).not.toBeInTheDocument();
  });

  it("hides add button when onAddWord is not provided", () => {
    render(<KnowledgeGraph data={sampleData} />);
    tapNode("n1");

    expect(screen.getByText("photosynthesis")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加入生词本/ })).not.toBeInTheDocument();
  });
});
