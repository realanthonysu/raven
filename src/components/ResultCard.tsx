/**
 * @module ResultCard
 * @description 结果卡片组件模块，以卡片形式展示 LLM 返回的分析结果，支持折叠/展开交互。
 * 是 CorrectPage 和 ReadingPage 的核心展示组件。
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * ResultCard 组件的 Props 接口
 *
 * 设计要点：
 * - variant 用于视觉区分不同重要程度的结果（如错误高亮、成功提示）
 * - collapsible 控制是否可折叠，Reading Copilot 的各分析维度默认可折叠
 * - defaultExpanded 控制初始展开状态，让关键信息（如纠正结果）默认可见
 */
interface ResultCardProps {
  /** 卡片标题 */
  title: string;
  /** 标题左侧的图标，使用 lucide-react 图标组件 */
  icon?: ReactNode;
  /** 视觉样式变体，通过边框颜色区分重要程度 */
  variant?: "default" | "highlight" | "success";
  /** 是否支持点击标题折叠/展开内容 */
  collapsible?: boolean;
  /** 初始是否展开，仅在 collapsible=true 时生效 */
  defaultExpanded?: boolean;
  /** 卡片内容 */
  children: ReactNode;
}

/** 不同变体的边框样式映射 */
const variantStyles = {
  default: "border-border",
  highlight: "border-primary/50",
  success: "border-green-500/50",
};

/**
 * 结果卡片组件
 *
 * 职责：以卡片形式展示 LLM 返回的分析结果，支持折叠/展开交互。
 * 是 CorrectPage 和 ReadingPage 的核心展示组件。
 *
 * 使用场景：
 * - CorrectPage：展示错误纠正、改写建议等（JSON 解析后的各个部分）
 * - ReadingPage：展示精读分析的多个维度（词汇、句法、修辞等）
 *
 * 性能说明：
 * - 条件渲染 expanded 内容（而非 CSS 隐藏），折叠时不产生不必要的 DOM 节点
 * - 简单的 useState 管理展开状态，无需 useReducer
 */
export function ResultCard({
  title,
  icon,
  variant = "default",
  collapsible = false,
  defaultExpanded = true,
  children,
}: ResultCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card className={cn(variantStyles[variant])}>
      <CardHeader
        className={cn(
          "py-3 px-4",
          // 可折叠时显示手型光标，提示用户可点击
          collapsible && "cursor-pointer select-none",
        )}
        onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
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
      {/* 条件渲染：折叠时不渲染内容，减少 DOM 节点数量 */}
      {expanded && (
        <CardContent className="px-4 pb-4 pt-0 text-sm leading-relaxed">{children}</CardContent>
      )}
    </Card>
  );
}
