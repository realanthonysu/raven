/**
 * @module ResultCard
 * @description 结果卡片组件模块，以卡片形式展示 LLM 返回的分析结果，支持折叠/展开交互。
 * 是 ReadingPage 和 HistoryDetailPage 的核心展示组件。
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * ResultCard 组件的 Props 接口
 *
 * 设计要点：
 * - variant 用于视觉区分不同重要程度的结果（如关键结果高亮）
 * - collapsible 控制是否可折叠，Reading Copilot 的各分析维度默认可折叠
 * - defaultExpanded 控制初始展开状态，让关键信息（如纠正结果）默认可见
 * - keepMounted 控制折叠策略：默认条件渲染（省 DOM），重型子树改用挂载后 CSS 隐藏
 */
interface ResultCardProps {
  /** 卡片标题 */
  title: string;
  /** 标题左侧的图标，使用 lucide-react 图标组件 */
  icon?: ReactNode;
  /** 视觉样式变体，通过边框颜色区分重要程度 */
  variant?: "default" | "highlight";
  /** 是否支持点击标题折叠/展开内容 */
  collapsible?: boolean;
  /** 初始是否展开，仅在 collapsible=true 时生效 */
  defaultExpanded?: boolean;
  /**
   * 首次展开后持续挂载子树，折叠时用 CSS（`hidden` 属性）隐藏（P-04）。
   *
   * 默认 `false`：折叠即卸载（短内容的最优策略，不产生多余 DOM）。
   * 对包含有状态重型实例的子树（Cytoscape 图谱、长 Markdown 的
   * ReactMarkdown 解析结果）设为 `true`，避免「折叠 → 再展开」时
   * 重建实例/重跑布局/全量重解析。
   *
   * 语义：`defaultExpanded=true` 时首帧即视为已展开过（子树立即挂载）
   */
  keepMounted?: boolean;
  /** 卡片内容 */
  children: ReactNode;
}

/** 不同变体的边框样式映射 */
const variantStyles = {
  default: "border-border",
  highlight: "border-primary/50",
};

/**
 * 结果卡片组件
 *
 * 职责：以卡片形式展示 LLM 返回的分析结果，支持折叠/展开交互。
 * 是 ReadingPage 和 HistoryDetailPage 的核心展示组件。
 *
 * 使用场景：
 * - ReadingPage：展示精读分析的多个维度（词汇、句法、修辞等）
 * - HistoryDetailPage：回放历史阅读记录时按 `## ` 标题拆分逐维度渲染
 *
 * 性能说明：
 * - 默认条件渲染 expanded 内容（而非 CSS 隐藏），折叠时不产生不必要的 DOM 节点
 * - `keepMounted` 为重型子树提供「展开一次后常驻 + CSS 隐藏」策略（见属性文档）
 * - 简单的 useState 管理展开状态，无需 useReducer
 */
export function ResultCard({
  title,
  icon,
  variant = "default",
  collapsible = false,
  defaultExpanded = true,
  keepMounted = false,
  children,
}: ResultCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  /**
   * 是否曾经展开过：keepMounted 模式下只有展开过的子树才常驻。
   * 初始值取 defaultExpanded —— 首帧展开的卡片立即进入常驻集合。
   */
  const [everExpanded, setEverExpanded] = useState(defaultExpanded);

  const toggleExpanded = useCallback(() => {
    // 在事件处理器里按当前渲染的 expanded 计算下一态：先标记"展开过"再切换，
    // 保证展开那一帧子树就已挂载（不闪烁）。默认条件渲染模式忽略 everExpanded。
    if (!expanded) setEverExpanded(true);
    setExpanded((v) => !v);
  }, [expanded]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded],
  );

  // 常驻模式：展开过一次后始终渲染子树，折叠仅通过 hidden 属性做 CSS 隐藏；
  // 普通模式：沿用条件渲染（折叠即卸载）
  const renderContent = keepMounted ? everExpanded : expanded;

  return (
    <Card className={cn(variantStyles[variant])}>
      <CardHeader
        className={cn(
          "py-3 px-4",
          // 可折叠时显示手型光标，提示用户可点击
          collapsible && "cursor-pointer select-none",
        )}
        role={collapsible ? "button" : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onKeyDown={collapsible ? handleKeyDown : undefined}
        onClick={collapsible ? toggleExpanded : undefined}
      >
        <CardTitle className="text-sm flex items-center gap-2">
          {icon}
          {title}
          {collapsible && (
            // 旋转 180 度表示展开状态，transition 提供平滑动画
            <ChevronDown
              className={cn(
                "ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          )}
        </CardTitle>
      </CardHeader>
      {renderContent && (
        // hidden 属性 = CSS display:none（浏览器 UA 样式表），DOM/实例/状态全部保留
        <CardContent
          className="px-4 pb-4 pt-0 text-sm leading-relaxed"
          hidden={!expanded}
          aria-hidden={!expanded || undefined}
        >
          {children}
        </CardContent>
      )}
    </Card>
  );
}
