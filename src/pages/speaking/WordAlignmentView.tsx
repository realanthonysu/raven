/**
 * @module WordAlignmentView
 * @description 词级对齐展示组件 —— 从 SpeakingPage 抽取为独立模块。
 *
 * 将原句每个词按发音状态着色，并显示 IPA 音标：
 * - correct: 绿色
 * - mispronounced: 黄色
 * - missed: 红色 + 删除线
 */

import type { WordAlignmentItem } from "@/types";

/** 发音状态的文本标签和 ARIA 语义映射 */
const STATUS_LABELS: Record<WordAlignmentItem["status"], string> = {
  correct: "正确",
  mispronounced: "有误",
  missed: "漏读",
};

/**
 * 词级对齐展示 —— 将原句每个词按发音状态着色，并显示 IPA 音标。
 * - correct: 绿色
 * - mispronounced: 黄色
 * - missed: 红色 + 删除线
 */
export function WordAlignmentView({ alignment }: { alignment: WordAlignmentItem[] }) {
  const statusStyles: Record<WordAlignmentItem["status"], string> = {
    correct: "text-green-600 dark:text-green-400",
    mispronounced: "text-yellow-600 dark:text-yellow-400",
    missed: "text-red-600 dark:text-red-400 line-through",
  };
  return (
    <ul
      className="flex flex-wrap gap-x-3 gap-y-2 pt-1 list-none pl-0"
      aria-label="词级发音对齐结果"
    >
      {alignment.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: alignment 项无唯一 id 且不会重新排序
        <li key={`${item.word}-${i}`} className="flex flex-col items-center">
          <span className={`text-sm font-medium ${statusStyles[item.status]}`}>{item.word}</span>
          <span className="text-xs text-muted-foreground">{item.ipa}</span>
          {/* L-7: 文本标签辅助色觉障碍用户区分状态 */}
          <span className={`text-[10px] ${statusStyles[item.status]} opacity-70`}>
            {STATUS_LABELS[item.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}
