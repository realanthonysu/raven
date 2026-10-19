/**
 * 数据访问层 barrel re-export —— 汇总所有 DB 子模块的导出。
 *
 * 各领域操作按子模块组织：models / words / history / settings / learning / review / tts / export。
 * 前端通过 Tauri invoke() 调用 Rust Command 执行 SQL，收窄 SQL 注入攻击面。
 * API Key 存储在 OS Keychain（Windows Credential Manager），不经过 SQLite。
 */

// 导出与备份
export {
  backupDatabase,
  backupDatabaseDefault,
  backupDatabaseDialog,
  exportWordsAnki,
  exportWordsCsv,
  restoreDatabase,
  writeTextFile,
  writeTextFileDialog,
} from "./export";
// 历史记录
// 注意：addHistory（原始写入）、getHistoryResultsByType / getRecentCorrectResults
// （getHistoryWithResults / buildPersonalizedContext 的内部通道）不在此导出
export {
  addHistorySafe,
  buildPersonalizedContext,
  deleteHistory,
  getHistoryById,
  getHistoryGraphData,
  getHistoryList,
  getHistoryOldestDate,
  getHistoryWithResults,
  type HistoryWithResults,
  updateHistoryGraphData,
} from "./history";
// 学习打卡与目标
export {
  getLearningGoals,
  getLearningStreak,
  getSidebarData,
  type LearningActivityType,
  recordLearningActivity,
  recordLearningActivitySafe,
  setLearningGoal,
} from "./learning";

// 模型配置
// 注意：invalidateDefaultModelCache 仅供本模块内部与测试使用，不经 barrel 导出
export {
  addModel,
  deleteModel,
  getDefaultModelCached,
  getModelApiKey,
  getModels,
  setDefaultModel,
  updateModel,
} from "./models";
// 复习统计与 FSRS
export { calculateAndUpdateReview, getReviewStats, getReviewWords } from "./review";
// 设置
export { getSetting, setSetting } from "./settings";

// TTS/ASR 配置
// 注意：invalidateTTSConfigCache 仅供本模块内部与测试使用，不经 barrel 导出
export {
  getASRModel,
  getTTSConfig,
  getTTSConfigCached,
  setASRModel,
  setTTSSettingBatch,
} from "./tts";
// 纯工具函数和类型
// 注意：FsrsCard / ReviewCalcResult 由 review.ts 直接从 ./utils 导入，不经 barrel 转发；
// 存储时间戳解析统一走 parseDbTimestamp（utils.ts 内无第二个解析入口）
export {
  aggregateCorrections,
  countStreak,
  getLocalDate,
  parseDbTimestamp,
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
