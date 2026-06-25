/**
 * 练习页面的共享配置常量。
 *
 * R9: 消除 SpeakingPage 和 ListeningPage 中重复的 DIFFICULTIES/TOPICS 定义。
 * 后续若抽取难度/主题选择 UI 组件，可在此处统一消费。
 */

/** 可选难度级别，用于 UI 按钮和 prompt 参数 */
export const DIFFICULTIES = ["初级", "中级", "高级"] as const;

/** 常见练习主题（口语/听力共用） */
export const TOPICS = [
  "日常对话",
  "商务英语",
  "旅游出行",
  "科技",
  "校园生活",
  "面试自我介绍",
] as const;

/** 判断给定主题是否为自定义（不在预设 TOPICS 列表中） */
export function isCustomTopic(topic: string): boolean {
  return !(TOPICS as readonly string[]).includes(topic);
}
