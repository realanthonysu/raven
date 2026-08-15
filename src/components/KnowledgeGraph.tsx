/**
 * @module KnowledgeGraph
 * @description 知识图谱可视化组件，使用 Cytoscape.js 将 LLM 解析出的文章知识结构
 * 以交互式力导向图谱形式展示，支持中英文切换和全屏模式。
 */

import cytoscape from "cytoscape";
import { Check, Languages, Loader2, Maximize2, Minimize2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLatestRef } from "@/hooks/use-latest-ref";

/**
 * 知识图谱节点数据结构
 * 由 LLM 解析文章后生成，包含中英文标签和节点类型
 */
interface GraphNode {
  /** 节点唯一标识符 */
  id: string;
  /** 中文标签（默认显示） */
  label: string;
  /** 英文标签（可选，用于中英文切换；LLM 可能返回 null） */
  labelEn?: string | null;
  /** 节点类型：concept（概念）或 entity（实体），决定节点颜色 */
  type: string;
}

/** 知识图谱边（关系）数据结构 */
interface GraphEdge {
  source: string;
  target: string;
  /** 关系描述文字，显示在边上 */
  relation: string;
}

/** 知识图谱完整数据结构 */
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface KnowledgeGraphProps {
  /** 图谱数据，由 ReadingPage 的 LLM 解析结果提供 */
  data: GraphData;
  /** 节点点击回调，可用于实现节点高亮、详情展示等扩展功能 */
  onNodeClick?: (nodeId: string) => void;
  /**
   * 将节点英文标签加入生词本的回调（复用 useAddToVocabulary）。
   * 提供后，点击节点会在底部信息栏显示"加入生词本"按钮。
   */
  onAddWord?: (word: string) => Promise<boolean>;
  /** 已加入生词本的单词集合，用于渲染按钮的"已添加"状态 */
  addedWords?: Set<string>;
}

/**
 * 获取当前主题对应的图谱颜色方案
 *
 * 设计原因：Cytoscape.js 直接操作 DOM canvas，不感知 Tailwind 主题变量，
 * 因此需要手动检测 <html> 的 dark class 来选择颜色。
 * 返回的对象包含节点、边、选中状态等所有颜色值。
 */
function getThemeColors() {
  const isDark = document.documentElement.classList.contains("dark");
  return isDark
    ? {
        node: "#60a5fa", // 默认节点：蓝色
        concept: "#a78bfa", // 概念节点：紫色
        entity: "#fbbf24", // 实体节点：金色
        edge: "#94a3b8", // 边线：灰色
        edgeLabel: "#94a3b8", // 边标签：灰色
        text: "#0f172a", // 节点文字：深色（在浅色背景节点上）
        selected: "#facc15", // 选中节点：黄色
        selectedText: "#0f172a",
        selectedBorder: "#facc15",
      }
    : {
        node: "#4a9eff",
        concept: "#9775fa",
        entity: "#ff9f43",
        edge: "#555",
        edgeLabel: "#888",
        text: "#fff", // 浅色主题下节点文字为白色（在深色背景节点上）
        selected: "#ffd43b",
        selectedText: "#000",
        selectedBorder: "#000",
      };
}

/**
 * 知识图谱可视化组件
 *
 * 职责：将 LLM 解析出的文章知识结构以交互式图谱形式展示。
 * 使用 Cytoscape.js 库进行图形渲染和布局计算。
 *
 * 核心功能：
 * 1. 自动布局：使用 COSE（Compound Spring Embedder）力导向布局算法
 * 2. 中英文切换：节点标签可在中英文间切换，便于不同语言背景的学习者
 * 3. 全屏模式：容器以 fixed 定位铺满视口（非 createPortal，DOM 节点保持不变以保留 Cytoscape 实例）
 * 4. 主题适配：根据 dark mode 动态切换颜色方案
 *
 * 性能优化策略：
 * - useRef 持有 Cytoscape 实例，避免 React 重渲染导致实例重建
 * - expandedRef 同步展开状态到 ref，供 Cytoscape 回调异步读取
 * - useLatestRef 持有 onNodeClick 回调，避免父组件渲染导致 Cytoscape 重建
 * - useCallback 缓存语言切换函数，避免子组件不必要的重渲染
 * - useEffect 仅依赖 [data]，语言切换通过 toggleLang 就地更新标签，不重建图谱
 *
 * 与 ReadingPage 的协作：
 * ReadingPage 调用 LLM 获取图谱 JSON 数据后传入本组件。
 * 组件不负责数据获取，只负责渲染和交互。
 */
export function KnowledgeGraph({ data, onNodeClick, onAddWord, addedWords }: KnowledgeGraphProps) {
  /** Cytoscape 容器的 DOM 引用 */
  const containerRef = useRef<HTMLDivElement>(null);
  /** Cytoscape 核心实例引用 */
  const cyRef = useRef<cytoscape.Core | null>(null);
  /** expanded 状态的 ref 副本，供 Cytoscape 异步回调安全读取 */
  const expandedRef = useRef(false);
  /** 当前显示语言：zh（中文）或 en（英文） */
  const [lang, setLang] = useState<"zh" | "en">("zh");
  /** 是否处于全屏模式 */
  const [expanded, setExpanded] = useState(false);
  /** 当前是否为深色模式，用于驱动 Cytoscape 颜色更新 */
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  /** 当前选中的节点，驱动底部信息栏（查词 + 加入生词本） */
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  /** 是否正在添加选中节点的单词到生词本 */
  const [addingWord, setAddingWord] = useState(false);

  // R7: 将 onNodeClick 存入 ref，避免父组件每次渲染创建新回调引用
  // 导致 Cytoscape 实例不必要地重建。useEffect 内通过 ref 读取最新回调。
  const onNodeClickRef = useLatestRef(onNodeClick);

  // 将 lang 存入 ref，供重建 effect 初始化 displayLabel 时读取当前语言。
  // lang 不放入重建 effect 的依赖数组：语言切换由 toggleLang 就地更新标签，
  // 避免销毁重建实例导致 COSE 布局重算和节点位置丢失。
  const langRef = useLatestRef(lang);

  // 全屏模式下按 Escape 退出（键盘可达性；此前只能 Tab 到"退出全屏"按钮）
  useEffect(() => {
    if (!expanded) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [expanded]);

  // 同步 expanded state 到 ref，解决 Cytoscape 回调中的闭包陈旧值问题
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // 检测数据中是否包含英文标签，没有则隐藏语言切换按钮
  const hasEnLabels = data.nodes.some((n) => n.labelEn);

  // 数据切换（新文章）时清除节点选中状态，避免信息栏残留旧图谱的节点
  // biome-ignore lint/correctness/useExhaustiveDependencies: data 仅作为触发依赖，用于在图谱数据变化时重置选中
  useEffect(() => {
    setSelectedNode(null);
  }, [data]);

  // 监听 document.documentElement 的 class 变化，检测 dark mode 切换
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  /**
   * 切换节点标签语言
   *
   * 直接操作 Cytoscape 实例的节点数据，而非重新创建整个图谱。
   * 这样切换语言时不会触发布局重新计算，保持节点位置不变。
   */
  const toggleLang = useCallback(() => {
    const newLang = lang === "zh" ? "en" : "zh";
    setLang(newLang);
    if (cyRef.current) {
      // 逐个更新节点的 displayLabel 数据字段
      cyRef.current.nodes().forEach((node) => {
        const d = node.data();
        const newLabel = newLang === "en" && d.labelEn ? d.labelEn : d.label;
        node.data("displayLabel", newLabel);
      });
      // 刷新样式以应用新的 label 数据
      cyRef.current.style().selector("node").style("label", "data(displayLabel)").update();
    }
  }, [lang]);

  /**
   * 创建和销毁 Cytoscape 实例
   *
   * 仅依赖 [data]：data 变化时需要重建（新文章的图谱数据完全不同）。
   *
   * lang 与 onNodeClick 均通过 useLatestRef 读取，不放入依赖数组：
   * - lang 变化由 toggleLang 就地更新 displayLabel，不触发重建（保持节点位置）
   * - onNodeClick 避免父组件每次渲染创建新回调引用时实例不必要地重建
   *
   * destroyed 标志位用于防止异步布局回调在组件卸载后执行。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: lang/onNodeClick 通过 ref 访问避免重建
  useEffect(() => {
    if (!containerRef.current) return;

    let destroyed = false;
    const c = getThemeColors();

    cyRef.current = cytoscape({
      container: containerRef.current,
      // 将节点和边的数据转换为 Cytoscape 的 elements 格式
      elements: [
        ...data.nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.label,
            labelEn: n.labelEn ?? "",
            // displayLabel 是实际渲染的标签，根据当前语言选择（ref 读取避免依赖 lang）
            displayLabel: langRef.current === "en" && n.labelEn ? n.labelEn : n.label,
            type: n.type,
          },
        })),
        // 边的 id 使用索引生成，因为原始数据没有唯一 id
        ...data.edges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.relation,
          },
        })),
      ],
      style: [
        // 默认节点样式
        {
          selector: "node",
          style: {
            label: "data(displayLabel)",
            "background-color": c.node,
            color: c.text,
            "text-valign": "center",
            "text-halign": "center",
            "font-size": "12px",
            // 节点大小自适应标签文字宽度
            width: "label",
            height: "label",
            padding: "8px",
            shape: "round-rectangle",
          } as cytoscape.Css.Node,
        },
        // 概念节点使用紫色，与实体节点区分
        {
          selector: "node[type='concept']",
          style: { "background-color": c.concept } as cytoscape.Css.Node,
        },
        // 实体节点使用金色
        {
          selector: "node[type='entity']",
          style: { "background-color": c.entity } as cytoscape.Css.Node,
        },
        // 边样式：带箭头的贝塞尔曲线
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": c.edge,
            "target-arrow-color": c.edge,
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "10px",
            color: c.edgeLabel,
            // autorotate 让边标签跟随边的方向旋转，提高可读性
            "text-rotation": "autorotate",
            "text-margin-y": -10,
          } as cytoscape.Css.Edge,
        },
        // 选中节点的高亮样式
        {
          selector: "node:selected",
          style: {
            "background-color": c.selected,
            color: c.selectedText,
            "border-width": 2,
            "border-color": c.selectedBorder,
          } as cytoscape.Css.Node,
        },
      ],
      layout: {
        name: "cose",
        // 关闭动画，大数据量时布局计算可能较慢，动画会进一步降低体验
        animate: false,
        // 节点排斥力，值越大节点间距越大
        nodeRepulsion: () => 8000,
        // 理想边长度，控制相连节点的间距
        idealEdgeLength: () => 120,
      } as cytoscape.LayoutOptions,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      // 禁用框选，避免与拖拽平移冲突
      boxSelectionEnabled: false,
    });

    // 绑定节点点击事件
    // R7: 通过 onNodeClickRef 读取最新回调，避免将 onNodeClick 放入依赖数组
    // 导致父组件每次渲染创建新回调引用时 Cytoscape 实例不必要地重建
    const handler = (evt: cytoscape.EventObject) => {
      // destroyed 检查防止组件卸载后回调仍执行
      if (destroyed) return;
      const id: string = evt.target.id();
      // 记录选中节点，驱动底部信息栏（查词 + 加入生词本）
      setSelectedNode(data.nodes.find((n) => n.id === id) ?? null);
      const cb = onNodeClickRef.current;
      if (cb) cb(id);
    };
    cyRef.current.on("tap", "node", handler);
    // 点击空白区域清除选中，收起信息栏
    cyRef.current.on("tap", (evt: cytoscape.EventObject) => {
      if (!destroyed && evt.target === cyRef.current) setSelectedNode(null);
    });

    // 清理函数：销毁 Cytoscape 实例
    return () => {
      destroyed = true;
      try {
        cyRef.current?.destroy();
      } catch {
        // 布局动画的异步回调可能在 destroy 后触发，忽略这些错误
      }
      cyRef.current = null;
    };
  }, [data]);

  // 主题切换时，仅更新样式而不销毁重建图谱（避免布局重算和闪烁）
  // biome-ignore lint/correctness/useExhaustiveDependencies: isDark 是触发依赖，通过 cy.style() 间接影响样式
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const c = getThemeColors();
    cy.style()
      .selector("node")
      .style({ "background-color": c.node, color: c.text })
      .selector("node[type='concept']")
      .style({ "background-color": c.concept })
      .selector("node[type='entity']")
      .style({ "background-color": c.entity })
      .selector("edge")
      .style({ "line-color": c.edge, "target-arrow-color": c.edge, color: c.edgeLabel })
      .selector("node:selected")
      .style({
        "background-color": c.selected,
        color: c.selectedText,
        "border-color": c.selectedBorder,
      })
      .update();
  }, [isDark]);

  // 全屏状态或容器尺寸变化时，通知 Cytoscape 重新计算尺寸并适配视口。
  // Cytoscape 只自动监听 window resize，无法感知容器尺寸变化——
  // PersistentRoutes 用 display:none 切换页面，恢复时容器从 0 尺寸变回
  // 不触发 window resize，画布会停留在旧缓冲/空白，必须用 ResizeObserver
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded 是触发依赖，通过 resize/fit 间接生效
  useEffect(() => {
    const container = containerRef.current;
    const cy = cyRef.current;
    if (!container || !cy) return;

    // 切换全屏时立即应用一次（过渡动画期间的尺寸变化由 observer 后续回调覆盖）
    cy.resize();
    cy.fit();

    const observer = new ResizeObserver(() => {
      // 读取 cyRef.current：回调触发时实例可能已因 data 变化被销毁重建
      const current = cyRef.current;
      if (!current) return;
      current.resize();
      current.fit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [expanded, data]);

  /** 将选中节点的英文标签加入生词本 */
  const handleAddWord = useCallback(async () => {
    const word = selectedNode?.labelEn?.trim();
    if (!word || !onAddWord) return;
    setAddingWord(true);
    try {
      await onAddWord(word);
    } finally {
      setAddingWord(false);
    }
  }, [selectedNode, onAddWord]);

  // 选中节点的英文单词及其"已添加"状态（label 为中文，加入生词本使用英文标签）
  const selectedWordEn = selectedNode?.labelEn?.trim() || null;
  const isAdded = selectedWordEn ? (addedWords?.has(selectedWordEn) ?? false) : false;

  return (
    <div
      className={
        expanded
          ? "fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col p-4"
          : "relative"
      }
    >
      {/* 工具栏（语言切换 + 全屏按钮） */}
      <div className="absolute top-2 right-2 z-10 flex gap-1.5">
        {hasEnLabels && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={toggleLang}>
            <Languages className="h-3.5 w-3.5" />
            {lang === "zh" ? "EN" : "中"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {expanded ? "退出全屏" : "全屏"}
        </Button>
      </div>

      {/* Cytoscape 容器 — 始终是同一个 DOM 节点，通过 CSS 切换尺寸。
          画布支持点击/拖拽/缩放，role="img" 会向屏幕阅读器错误地宣布为静态图片 */}
      <div
        ref={containerRef}
        role="application"
        aria-label="知识图谱交互画布：展示文章核心概念及其关系，支持缩放与拖拽"
        className={
          expanded
            ? "flex-1 border rounded-md bg-background"
            : "w-full h-[500px] border rounded-md bg-background"
        }
      />

      {/* 节点选中信息栏：显示中英文标签，可将英文标签加入生词本 */}
      {selectedNode && (
        <div
          className={`absolute z-10 flex items-center gap-3 rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur-sm ${
            expanded ? "bottom-6 left-6 right-6" : "bottom-2 left-2 right-2"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{selectedNode.label}</div>
            {selectedWordEn && (
              <div className="truncate text-xs text-muted-foreground">{selectedWordEn}</div>
            )}
          </div>
          {onAddWord &&
            selectedWordEn &&
            (isAdded ? (
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled>
                <Check className="h-3.5 w-3.5" />
                已添加
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={handleAddWord}
                disabled={addingWord}
              >
                {addingWord ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                加入生词本
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
