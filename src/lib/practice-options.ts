/**
 * 练习页面的共享配置常量。
 *
 * R9: 消除 SpeakingPage 和 ListeningPage 中重复的 TOPICS 定义；
 * 主题选择 UI 已由 PracticeOptionsSelector 组件统一消费本模块常量。
 *
 * 英语水平级别体系：难度选项不再由本模块自定义 初级/中级/高级 三档——
 * 用户基准级别（settings 的 proficiency_level）经 @/lib/levels 的
 * practiceLevelOptions() 派生「低一档/标准/挑战」三档，教学规格与
 * 「码（≈考试锚点）」双标注标签的单一事实来源均在 levels 模块。
 * 本模块仅做 re-export（消费方导入路径不变），并额外提供 difficulty
 * 展示格式化入口。
 */

import { isLevelCode, levelLabel } from "@/lib/levels";

export type { LevelCode, PracticeLevelOption } from "@/lib/levels";
export { isLevelCode, levelLabel, practiceLevelOptions } from "@/lib/levels";

/** 常见练习主题（口语/听力共用） */
export const TOPICS = [
  "日常对话",
  "商务英语",
  "旅游出行",
  "科技",
  "校园生活",
  "面试自我介绍",
] as const;

/**
 * 判断给定主题是否为用户自定义（不在预设 TOPICS 列表中）。
 *
 * 当用户手动输入非预设主题时返回 true，UI 层据此决定是否显示"自定义"标签。
 *
 * @param topic - 待检查的主题名称
 * @returns true 表示自定义主题，false 表示预设主题
 */
export function isCustomTopic(topic: string): boolean {
  return !(TOPICS as readonly string[]).includes(topic);
}

/**
 * 难度展示格式化 —— 持久化 difficulty 字符串的统一渲染入口。
 *
 * 新数据存 CEFR 级别码（如 "B2"），渲染为「码（≈考试锚点）」双标注标签；
 * 旧数据（初级/中级/高级 等非级别码字符串）原样返回，存量记录展示不变。
 *
 * @param v - 结果 JSON 中的 difficulty 原始字符串
 * @returns 可直接展示的难度文案
 */
export function formatDifficultyLabel(v: string): string {
  return isLevelCode(v) ? levelLabel(v) : v;
}
