/**
 * KnowledgeGraph 节点选中信息栏交互测试。
 *
 * cytoscape 在 jsdom 下无法真实渲染 canvas，因此 mock 整个 cytoscape 模块，
 * 捕获 tap 事件处理器后手动触发，验证信息栏与"加入生词本"按钮的行为。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// ─── ResizeObserver 合并（H-07）────────────────────────────────────────
// 同一帧内的多次尺寸回调只保留一次 rAF resize；fit 推迟到尺寸稳定
// ~120ms 后执行一次（拖拽窗口 / 全屏 CSS 过渡期间不逐帧重算包围盒）。

describe("KnowledgeGraph ResizeObserver coalescing (H-07)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces same-frame resize callbacks into one rAF and fits once after the burst", async () => {
    vi.clearAllMocks();
    // 默认替身 + captured 标志：避免 TS 把「仅由构造器赋值」的 let 变量
    // 收窄成 null 类型（CFA 看不到构造器里的赋值）
    let observerCallback: ResizeObserverCallback = () => {
      throw new Error("ResizeObserver 回调尚未被捕获");
    };
    let callbackCaptured = false;
    class CapturingResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        observerCallback = cb;
        callbackCaptured = true;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);

    let rafSeq = 0;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafSeq += 1;
      pendingFrames.set(rafSeq, cb);
      return rafSeq;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      pendingFrames.delete(id);
    });

    const { unmount } = render(<KnowledgeGraph data={sampleData} />);

    // 挂载/expanded/data 切换保留立即 resize + fit（首帧可见性优先）
    expect(mockCy.resize).toHaveBeenCalledTimes(1);
    expect(mockCy.fit).toHaveBeenCalledTimes(1);
    expect(callbackCaptured).toBe(true);

    // 同一帧内连续三次尺寸回调（如全屏过渡）：只排下 1 个 rAF
    for (let i = 0; i < 3; i++) observerCallback([], {} as ResizeObserver);
    expect(pendingFrames.size).toBe(1);

    // 执行合并后的 rAF：只 resize 画布，不立即 fit
    act(() => {
      for (const cb of pendingFrames.values()) cb(0);
    });
    pendingFrames.clear();
    expect(mockCy.resize).toHaveBeenCalledTimes(2);
    expect(mockCy.fit).toHaveBeenCalledTimes(1);

    // trailing 120ms：尺寸稳定后再 resize + fit 一次
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockCy.resize).toHaveBeenCalledTimes(3);
    expect(mockCy.fit).toHaveBeenCalledTimes(2);

    unmount();
  });
});
