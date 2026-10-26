/**
 * Settings 表 key 的单一来源：与 Rust 侧 `ALLOWED_SETTINGS` 白名单
 * （src-tauri/src/commands/settings.rs）一一对应，由契约测试
 * `settings-keys.test.ts` 双向锁定集合相等。
 *
 * 为什么要有这个模块：Rust 白名单是唯一守门人（`db_get_setting`/`db_set_setting`
 * 拒绝未登记的 key），但 TS 侧此前没有镜像清单，裸字符串散布在多个调用点——
 * 「TS 用了新 key、Rust 漏登记」只能在运行时发现（见 AGENTS.md 的警告）。
 * 收敛后：新增设置项需同时登记本表与 Rust 白名单，两侧任一缺失契约测试即红；
 * 只在本表登记而 Rust 未登记的 key 同样会被测试报出（而非等到运行时被拒）。
 *
 * 历史注记：`review_notify_time` 曾只存在于 Rust 白名单、TS 侧零引用（死 key），
 * 已于 2026-10 从两侧一并删除——这类死 key 如今会由契约测试直接报错。
 */
export const SETTINGS_KEYS = {
  /** 首次启动引导是否已完成（存 "true"；其余值/未设置均视为未完成） */
  onboardingDone: "onboarding_done",
  /** ASR 模型名（存模型名字符串；ASR 复用 TTS 的 base_url） */
  asrModel: "asr_model",
  /** 上次备份时间（存 `new Date().toISOString()`，UTC ISO 8601） */
  lastBackupTime: "last_backup_time",
  /** 上次备份目标路径（存用户在保存对话框中选择的完整路径） */
  lastBackupPath: "last_backup_path",
  /** 每日复习提醒开关（存 "true"/"false"；读侧 `!== "false"`，默认启用） */
  notificationEnabled: "notification_enabled",
  /** 最近一次发送复习提醒的日期（存 `getLocalDate()` 本地时区 "YYYY-MM-DD"；关闭开关时清空为 ""） */
  lastNotificationDate: "last_notification_date",
  /** FSRS 目标留存率（存十进制字符串如 "0.9"；Rust 侧 parse 为 f64 并 clamp [0.7, 0.97]） */
  fsrsRequestRetention: "fsrs_request_retention",
  /** 用户 CEFR 级别码（存 LevelCode 字符串，见 lib/levels.ts） */
  proficiencyLevel: "proficiency_level",
  /** AI 定级测试结果（存 PlacementResult 的 JSON 字符串，只保留最新一次） */
  placementResult: "placement_result",
  /** TTS 服务 base_url（缺省时 Rust 侧回退 MiMo 开放平台默认值） */
  ttsBaseUrl: "tts_base_url",
  /** TTS 模型名 */
  ttsModel: "tts_model",
  /** TTS 音色名 */
  ttsVoice: "tts_voice",
  /** TTS 语速（存十进制字符串如 "1.0"；Rust 侧 parse 为 f64） */
  ttsSpeed: "tts_speed",
  /** TTS 方言（仅允许 "mimo"/"openai"，Rust 侧值级校验） */
  ttsDialect: "tts_dialect",
} as const;

/** SETTINGS_KEYS 值的联合类型（合法 settings key 字面量） */
export type SettingKeyName = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
