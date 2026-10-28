import { vi } from "vitest";

/**
 * 共享的 `@/lib/db` barrel 测试 fake —— 单一 mock 来源，替代每个测试文件
 * 手写的 `vi.mock("@/lib/db", () => ({ ... }))` 字面量。
 *
 * 定位与边界：
 * - 适用于「mock 整个 @/lib/db barrel」的页面/hook 测试（vitest 工厂返回本对象）；
 * - **不适用于** db 层自身的单元测试（如 settings.test.ts / tts.test.ts）——
 *   它们 mock 的是 `@tauri-apps/api/core` 的 invoke，走真实 db 模块，需要断言
 *   invoke 参数形态，全 barrel fake 反而会把被测对象 mock 掉；
 * - 默认值取各函数的"空态"语义（空列表 / null / undefined / 默认配置），
 *   需要非空数据的用例用 overrides 覆盖或在 beforeEach 里 mockResolvedValue。
 *
 * 用法（vi.mock 工厂会被提升到 import 之前，须用工厂内动态 import 取本模块）：
 *   vi.mock("@/lib/db", async () => {
 *     const { createDbMock } = await import("@/test/db-mock");
 *     return createDbMock({ getDefaultModelCached: vi.fn().mockResolvedValue(MODEL) });
 *   });
 * 断言时从 "@/lib/db" 导入同名函数并 `vi.mocked(fn)`——mock 实例由模块缓存保证
 * 是同一份。注意：若测试用了 vi.resetAllMocks()/vi.restoreAllMocks()，工厂里
 * 配置的默认实现会被清掉，必要项需在 beforeEach 重新配置（与手写 mock 一致）。
 */

/** db mock 对象类型：键为 barrel 导出名，值为 vi.fn() */
export type DbMock = Record<string, ReturnType<typeof vi.fn>>;

/** TTS 配置空态（与 Rust build_tts_config 的默认值口径一致） */
const EMPTY_TTS_CONFIG = {
  base_url: "https://api.xiaomimimo.com/v1",
  api_key: "",
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  speed: 1.0,
  dialect: "mimo",
};

/** ReviewStats 空态（camelCase，见 lib/db/utils.ts） */
const EMPTY_REVIEW_STATS = {
  total: 0,
  newCount: 0,
  learningCount: 0,
  masteredCount: 0,
  dueCount: 0,
};

/**
 * 创建完整的 `@/lib/db` barrel mock。
 *
 * @param overrides - 浅合并覆盖默认值（通常传入带实现的 vi.fn()）
 */
export function createDbMock(overrides: DbMock = {}): DbMock {
  return {
    // ── models ──
    getModels: vi.fn().mockResolvedValue([]),
    // 默认解析 null：与"未配置模型"的运行时空态一致，hook 侧会给出规范错误文案
    getDefaultModelCached: vi.fn().mockResolvedValue(null),
    addModel: vi.fn().mockResolvedValue({ lastInsertId: 1 }),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    setDefaultModel: vi.fn().mockResolvedValue(undefined),
    updateModel: vi.fn().mockResolvedValue(undefined),
    getModelApiKey: vi.fn().mockResolvedValue(""),

    // ── settings（类型化 wrapper，wire 空态） ──
    // 级别默认 B1（DEFAULT_LEVEL）：与真实 getProficiencyLevel 的 fail-soft
    // 回落一致——未 mock 时页面测试的级别相关断言（B1 徽章/难度档）语义不变
    getProficiencyLevel: vi.fn().mockResolvedValue("B1"),
    setProficiencyLevel: vi.fn().mockResolvedValue(undefined),
    getPlacementResult: vi.fn().mockResolvedValue(null),
    setPlacementResult: vi.fn().mockResolvedValue(undefined),
    getOnboardingDone: vi.fn().mockResolvedValue(false),
    setOnboardingDone: vi.fn().mockResolvedValue(undefined),
    // 通知默认启用（读侧契约：只有显式 "false" 才关闭）
    getNotificationEnabled: vi.fn().mockResolvedValue(true),
    setNotificationEnabled: vi.fn().mockResolvedValue(undefined),
    getLastNotificationDate: vi.fn().mockResolvedValue(null),
    setLastNotificationDate: vi.fn().mockResolvedValue(undefined),
    getLastBackupTime: vi.fn().mockResolvedValue(null),
    setLastBackupTime: vi.fn().mockResolvedValue(undefined),
    getLastBackupPath: vi.fn().mockResolvedValue(null),
    setLastBackupPath: vi.fn().mockResolvedValue(undefined),
    getFsrsRequestRetention: vi.fn().mockResolvedValue(null),
    setFsrsRequestRetention: vi.fn().mockResolvedValue(undefined),

    // ── history ──
    getHistoryList: vi.fn().mockResolvedValue([]),
    // 注意真实返回形态是 { records, resultById }，不是裸数组
    getHistoryWithResults: vi.fn().mockResolvedValue({ records: [], resultById: new Map() }),
    getHistoryById: vi.fn().mockResolvedValue(null),
    getHistoryGraphData: vi.fn().mockResolvedValue(null),
    getHistoryOldestDate: vi.fn().mockResolvedValue(null),
    deleteHistory: vi.fn().mockResolvedValue(undefined),
    updateHistoryGraphData: vi.fn().mockResolvedValue(undefined),
    buildPersonalizedContext: vi.fn().mockResolvedValue(""),

    // ── learning ──
    getLearningGoals: vi.fn().mockResolvedValue({}),
    getLearningStreak: vi.fn().mockResolvedValue(0),
    getSidebarData: vi.fn().mockResolvedValue({
      review_stats: {
        total: 0,
        new_count: 0,
        learning_count: 0,
        mastered_count: 0,
        due_count: 0,
      },
      streak: 0,
      goals: [],
      today_activities: null,
    }),
    recordLearningActivity: vi.fn().mockResolvedValue(undefined),
    recordLearningActivitySafe: vi.fn().mockResolvedValue(undefined),
    setLearningGoal: vi.fn().mockResolvedValue(undefined),

    // ── review ──
    getReviewStats: vi.fn().mockResolvedValue(EMPTY_REVIEW_STATS),
    getReviewWords: vi.fn().mockResolvedValue([]),
    calculateAndUpdateReview: vi.fn().mockResolvedValue(undefined),

    // ── tts / asr ──
    getTTSConfig: vi.fn().mockResolvedValue(EMPTY_TTS_CONFIG),
    getTTSConfigCached: vi.fn().mockResolvedValue(EMPTY_TTS_CONFIG),
    setTTSSettingBatch: vi.fn().mockResolvedValue(undefined),
    getASRModel: vi.fn().mockResolvedValue("mimo-v2.5-asr"),
    setASRModel: vi.fn().mockResolvedValue(undefined),

    // ── words ──
    getWords: vi.fn().mockResolvedValue([]),
    addWord: vi.fn().mockResolvedValue({ lastInsertId: 1 }),
    deleteWord: vi.fn().mockResolvedValue(undefined),
    updateWordLevel: vi.fn().mockResolvedValue(undefined),
    updateWordEnrichment: vi.fn().mockResolvedValue(undefined),

    // ── export / backup ──
    exportWordsCsv: vi.fn().mockResolvedValue(""),
    exportWordsAnki: vi.fn().mockResolvedValue(""),
    writeTextFileDialog: vi.fn().mockResolvedValue(undefined),
    backupDatabaseDialog: vi.fn().mockResolvedValue(null), // 用户取消对话框的空态
    backupDatabaseDefault: vi.fn().mockResolvedValue("backup.db"),
    restoreDatabase: vi.fn().mockResolvedValue(undefined),

    // ── 纯工具（barrel 转发，同步函数用同步实现）──
    // 固定日期保证用例确定性；需要"真实今天"的用例应覆写
    getLocalDate: vi.fn(() => "2026-01-01"),
    parseDbTimestamp: vi.fn((s: string) => new Date(s)),
    aggregateCorrections: vi.fn(() => ({})),
    countStreak: vi.fn(() => 0),

    // overrides 最后展开：浅合并，键级覆盖默认实现
    ...overrides,
  };
}
