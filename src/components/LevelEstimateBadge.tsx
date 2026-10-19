/**
 * @module LevelEstimateBadge
 * @description 写作水平估级徽章（CEFR 级别体系，Writing Copilot 专用）。
 *
 * LLM 在纠错结果中附带 level_estimate（band + rationale），本组件将其渲染为
 * "估级 B1+"徽章 + 判断依据小字。CorrectPage 与历史详情 WritingDetail 共用，
 * 保证两处展示一致。
 */

import { isLevelCode } from "@/lib/levels";

/**
 * LevelEstimateBadge 组件的属性接口。
 *
 * 结构与 CorrectionResult["level_estimate"] 对齐（band + rationale），
 * 但不直接依赖 CorrectionResult 类型——调用方传入解析结果的对应字段即可。
 */
interface LevelEstimateBadgeProps {
  /** LLM 返回的估级数据；旧数据/解析失败时为 undefined */
  estimate: { band: string; rationale: string } | undefined;
}

/**
 * 写作水平估级徽章组件。
 *
 * 渲染规则（旧数据兼容）：
 * - estimate 缺失或 band 不是合法 CEFR 级别码（isLevelCode 兜底）时渲染 nothing；
 * - 合法时显示蓝色系徽章"估级 {band}"，rationale 以徽章旁小字呈现。
 *
 * 使用示例：
 * ```tsx
 * <LevelEstimateBadge estimate={parsed.level_estimate} />
 * ```
 */
export function LevelEstimateBadge({ estimate }: LevelEstimateBadgeProps) {
  // band 宽松来自 schema（z.string()）：LLM 可能输出六档之外的意外值，
  // 展示层经 isLevelCode 校验，非法档位不渲染徽章
  if (!estimate || !isLevelCode(estimate.band)) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs px-2.5 py-0.5 font-medium">
        估级 {estimate.band}
      </span>
      <span className="text-xs text-muted-foreground leading-relaxed">{estimate.rationale}</span>
    </div>
  );
}
