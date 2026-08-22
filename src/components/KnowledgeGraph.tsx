/**
 * @module KnowledgeGraph
 * @description 知识图谱可视化组件，使用 Cytoscape.js 将 LLM 解析出的文章知识结构
 * 以交互式力导向图谱形式展示，支持中英文切换和全屏模式。
 *
 * Cytoscape 实例管理（创建/销毁/主题/语言/选中/尺寸适配）封装在
 * ./knowledge-graph/use-cytoscape-graph 自定义 hook 中，本组件只负责渲染与交互 UI。
 */

import { Check, Languages, Loader2, Maximize2, Minimize2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type GraphNode, useCytoscapeGraph } from "./knowledge-graph/use-cytoscape-graph";

interface KnowledgeGraphProps {
  /** 图谱数据，由 ReadingPage 的 LLM 解析结果提供 */
  data: {
    nodes: GraphNode[];
    edges: { source: string; target: string; relation: string }[];
  };
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
 * 知识图谱可视化组件
 *
 * 职责：将 LLM 解析出的文章知识结构以交互式图谱形式展示。
 * 使用 Cytoscape.js 库进行图形渲染和布局计算（实例管理见 use-cytoscape-graph hook）。
 *
 * 核心功能：
 * 1. 自动布局：使用 COSE（Compound Spring Embedder）力导向布局算法
 * 2. 中英文切换：节点标签可在中英文间切换，便于不同语言背景的学习者
 * 3. 全屏模式：容器以 fixed 定位铺满视口（非 createPortal，DOM 节点保持不变以保留 Cytoscape 实例）
 * 4. 主题适配：根据 dark mode 动态切换颜色方案
 *
 * 性能优化策略：
 * - Cytoscape 实例由 hook 内的 useRef 持有，避免 React 重渲染导致实例重建
 * - useLatestRef 持有 onNodeClick 回调，避免父组件渲染导致 Cytoscape 重建
 * - useCallback 缓存语言切换函数，避免子组件不必要的重渲染
 *
 * 与 ReadingPage 的协作：
 * ReadingPage 调用 LLM 获取图谱 JSON 数据后传入本组件。
 * 组件不负责数据获取，只负责渲染和交互。
 */
export function KnowledgeGraph({ data, onNodeClick, onAddWord, addedWords }: KnowledgeGraphProps) {
  /** expanded 状态的 ref 副本（保留既有结构：hook 通过参数读取全屏状态） */
  const [expanded, setExpanded] = useState(false);
  /** 是否正在添加选中节点的单词到生词本 */
  const [addingWord, setAddingWord] = useState(false);

  // 全屏模式下按 Escape 退出（键盘可达性；此前只能 Tab 到"退出全屏"按钮）
  useEffect(() => {
    if (!expanded) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [expanded]);

  // Cytoscape 实例与主题/语言/选中节点管理（hook 内行为与原实现一致）
  const { containerRef, lang, toggleLang, selectedNode } = useCytoscapeGraph({
    data,
    onNodeClick,
    expanded,
  });

  // 检测数据中是否包含英文标签，没有则隐藏语言切换按钮
  const hasEnLabels = data.nodes.some((n) => n.labelEn);

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
