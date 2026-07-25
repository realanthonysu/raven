/**
 * 数据访问层 —— 通过 Tauri Command 调用 Rust 端的数据库操作。
 *
 * 架构变更（v2）：
 * - 移除 @tauri-apps/plugin-sql，所有 SQL 操作在 Rust 端完成
 * - API Key 存储在 OS Keychain（Windows Credential Manager），不再经过 SQLite
 * - 前端通过 invoke() 调用 Rust Command，收窄 SQL 注入攻击面
 *
 * 本文件为 barrel re-export，各领域操作按子模块组织。
 */

// 导出与备份
export { backupDatabase, exportWordsAnki, exportWordsCsv, writeTextFile } from "./export";
// 历史记录
export {
  addHistory,
  addHistorySafe,
  buildPersonalizedContext,
  deleteHistory,
  getHistory,
  getHistoryById,
  getHistoryList,
  updateHistoryGraphData,
} from "./history";
// 学习打卡与目标
export {
  getLearningGoals,
  getLearningStreak,
  getSidebarData,
  recordLearningActivity,
  recordLearningActivitySafe,
  setLearningGoal,
} from "./learning";

// 模型配置
export {
  addModel,
  deleteModel,
  getDefaultModelCached,
  getModels,
  invalidateDefaultModelCache,
  setDefaultModel,
  updateModel,
} from "./models";
// 复习统计与 FSRS
export { calculateAndUpdateReview, getReviewStats, getReviewWords } from "./review";
// 设置
export { getSetting, setSetting } from "./settings";

// TTS/ASR 配置
export {
  getASRModel,
  getTTSConfig,
  getTTSConfigCached,
  invalidateTTSConfigCache,
  setASRModel,
  setTTSSettingBatch,
} from "./tts";
// 纯工具函数和类型
export {
  aggregateCorrections,
  countStreak,
  type FsrsCard,
  getLocalDate,
  type ReviewCalcResult,
  type ReviewStats,
} from "./utils";
// 生词本
export {
  addWord,
  deleteWord,
  getWords,
  updateWordEnrichment,
  updateWordLevel,
} from "./words";
