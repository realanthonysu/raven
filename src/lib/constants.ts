/**
 * 跨模块共享的魔法字符串常量 —— 收敛散落在各页面/组件中的字面量。
 */

/** words 表 source_type 字段的取值（词汇来源） */
export const SOURCE_TYPE = {
  /** 手动添加 */
  manual: "manual",
  /** CSV/TXT 批量导入 */
  import: "import",
  /** 阅读页添加 */
  reading: "reading",
  /** 口语错词添加 */
  speaking: "speaking",
} as const;

/** words 表 review_status 字段的取值（复习三态机） */
export const REVIEW_STATUS = {
  new: "new",
  learning: "learning",
  mastered: "mastered",
} as const;

/** 页面临时操作反馈消息的类型（VocabularyPage 等） */
export type FeedbackType = "success" | "info" | "error";
