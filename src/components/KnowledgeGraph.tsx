import { useState, useEffect, useRef, useCallback } from "react";
import cytoscape from "cytoscape";
import { Button } from "@/components/ui/button";
import { Languages, Maximize2, Minimize2 } from "lucide-react";

/**
 * 知识图谱节点数据结构
 * 由 LLM 解析文章后生成，包含中英文标签和节点类型
 */
interface GraphNode {
  /** 节点唯一标识符 */
  id: string;
  /** 中文标签（默认显示） */
  label: string;
  /** 英文标签（可选，用于中英文切换） */
  labelEn?: string;
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
        node: "#60a5fa",        // 默认节点：蓝色
        concept: "#a78bfa",     // 概念节点：紫色
        entity: "#fbbf24",      // 实体节点：金色
        edge: "#94a3b8",        // 边线：灰色
        edgeLabel: "#94a3b8",   // 边标签：灰色
        text: "#0f172a",        // 节点文字：深色（在浅色背景节点上）
        selected: "#facc15",    // 选中节点：黄色
        selectedText: "#0f172a",
        selectedBorder: "#facc15",
      }
    : {
        node: "#4a9eff",
        concept: "#9775fa",
        entity: "#ff9f43",
        edge: "#555",
        edgeLabel: "#888",
        text: "#fff",           // 浅色主题下节点文字为白色（在深色背景节点上）
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
 * 3. 全屏模式：通过 createPortal 渲染到 document.body，脱离父容器限制
 * 4. 主题适配：根据 dark mode 动态切换颜色方案
 *
 * 性能优化策略：
 * - useRef 持有 Cytoscape 实例，避免 React 重渲染导致实例重建
 * - expandedRef 同步展开状态到 ref，供 Cytoscape 回调异步读取
 * - useCallback 缓存语言切换函数，避免子组件不必要的重渲染
 * - useEffect 依赖 [data, onNodeClick, lang]，仅在数据变化时重建图谱
 *
 * 与 ReadingPage 的协作：
 * ReadingPage 调用 LLM 获取图谱 JSON 数据后传入本组件。
 * 组件不负责数据获取，只负责渲染和交互。
 */
export function KnowledgeGraph({ data, onNodeClick }: KnowledgeGraphProps) {
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

  // 同步 expanded state 到 ref，解决 Cytoscape 回调中的闭包陈旧值问题
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // 检测数据中是否包含英文标签，没有则隐藏语言切换按钮
  const hasEnLabels = data.nodes.some((n) => n.labelEn);

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
      cyRef.current.style()
        .selector("node")
        .style("label", "data(displayLabel)")
        .update();
    }
  }, [lang]);

  /**
   * 创建和销毁 Cytoscape 实例
   *
   * 依赖 [data, onNodeClick, lang]：
   * - data 变化时需要重建（新文章的图谱数据完全不同）
   * - lang 变化时需要重建（因为 displayLabel 在初始化时就设置了）
   * - onNodeClick 变化时需要重新绑定事件
   *
   * destroyed 标志位用于防止异步布局回调在组件卸载后执行。
   */
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
            // displayLabel 是实际渲染的标签，根据当前语言选择
            displayLabel: lang === "en" && n.labelEn ? n.labelEn : n.label,
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
    if (onNodeClick) {
      cyRef.current.on("tap", "node", (evt) => {
        // destroyed 检查防止组件卸载后回调仍执行
        if (!destroyed) onNodeClick(evt.target.id());
      });
    }

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lang is used for initial displayLabel setup but toggleLang handles runtime switching without needing a full rebuild
  }, [data, onNodeClick]);

  // 全屏状态变化时，通知 Cytoscape 重新计算容器尺寸并适配视口
  useEffect(() => {
    if (cyRef.current) {
      cyRef.current.resize();
      cyRef.current.fit();
    }
  }, [expanded]);

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
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={toggleLang}
          >
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

      {/* Cytoscape 容器 — 始终是同一个 DOM 节点，通过 CSS 切换尺寸 */}
      <div
        ref={containerRef}
        className={
          expanded
            ? "flex-1 border rounded-md bg-background"
            : "w-full h-[500px] border rounded-md bg-background"
        }
      />
    </div>
  );
}
