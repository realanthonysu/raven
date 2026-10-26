/**
 * 练习页面的共享配置常量（主题清单）。
 *
 * R9: 消除 SpeakingPage 和 ListeningPage 中重复的 TOPICS 定义；
 * 主题选择 UI 已由 PracticeOptionsSelector 组件统一消费本模块常量。
 *
 * 级别体系相关的全部内容（LevelCode / practiceLevelOptions /
 * formatDifficultyLabel）均在 @/lib/levels —— 本模块曾是其转发层，
 * 收敛后只剩真正的自有内容：主题清单。
 */

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
