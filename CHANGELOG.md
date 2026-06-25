# Changelog / 更新日志

---

## v1.8.0

### 中文

第二轮代码审查修复——26 项跨安全、架构、错误处理、类型安全的系统性修复。引入 `FsrsState` enum、参数 struct 重构、`useReducer` 状态管理、`useAbortable` 统一取消控制，并新增 6 个 FSRS 算法单元测试。

**安全**

- **HTTP 权限修正** — `capabilities/default.json` 改为 HTTPS 保持开放（用户可配置任意 OpenAI 兼容端点），HTTP 收紧为 `127.0.0.1` / `localhost`（防 SSRF 访问内网服务）。v1.7.0 的固定域名白名单会导致第三方模型（Mistral/Groq/Together AI/自托管）配置失败，已修正
- **路径穿越防护** — `write_text_file` 添加系统敏感目录校验（Windows `C:\Windows\` / `C:\Program Files`，Linux `/etc/` `/usr/`，macOS `/System/`），拒绝写入并记录 `tracing::warn`
- **白名单校验扩展** — `update_word_review_fsrs` 添加 `validate_review_status`；`query_history` 添加 `validate_record_type` 逐项校验，补全覆盖盲区

**架构**

- **`FsrsState` enum**（`fsrs.rs`）— `FsrsCard.state` 从 `i64` 改为 `FsrsState` enum（New/Learning/Review/Relearning），带 `#[serde(into/from)]` 保证前后端数字编码兼容，未知值降级为 New 并记录日志
- **参数 struct 重构** — `db_update_word_review_fsrs`（12 参数）和 `db_add_word`（10 参数）重构为 `FsrsReviewUpdate` / `NewWordInput` struct，消除 `#[allow(clippy::too_many_arguments)]`
- **`backup_db` 非阻塞** — 改用 `tokio::task::spawn_blocking`，避免长时间持有连接池连接阻塞 async 运行时
- **SettingsPage `useReducer`** — 语音设置 11 个 `useState` 合并为单个 `voiceReducer`，状态集中管理
- **DashboardPage `useAbortable`** — 替换手动 `AbortController`，signal 透传到 `getReviewStats` / `getLearningStreak` / `getHistory`

**错误处理**

- **`handleSaveGoals` 原子性** — `Promise.all` 改为 `Promise.allSettled`，部分失败时不回滚已成功项，而是重新加载实际值同步 UI 与 DB
- **SettingsPage 初始加载** — 5 个 Promise 添加 `.catch(console.warn)`，避免 unhandled rejection
- **`getNotificationPermission` 返回值** — 错误时返回 `"default"` 而非 `"denied"`，避免 UI 误导用户"已拒绝"
- **useAnalytics `getHistory`** — 失败时添加 `console.warn`，不再静默吞掉错误

**类型安全**

- **SpeakingPage `handleStop` 竞态修复** — `SET_SCORE` action 携带 `index`，reducer 不再依赖 `state.currentIndex`，异步评估期间切句不会导致分数写入错位
- **`handleFinish` 零分污染修复** — 未完成句子用 `score: null` + `skipped: true` 标记，不再填充零分对象污染 analytics 趋势数据
- **ReviewPage Zod 校验** — `loadReviewSession` 用 `SavedReviewSessionSchema` 替代 `as` 断言，防止 localStorage 篡改导致 undefined 字段
- **`extractJson` type predicate** — 添加函数重载，`validate` 参数支持 `(data: unknown) => data is T` 类型收窄，不再退化为 `boolean`
- **use-recording auto-stop 修复** — auto-stop 触发前注册 `onstop` 处理器，避免音频数据丢失和 recording 状态卡死
- **SpeakingPage auto-play cleanup** — useEffect 添加 `return () => stopTTS()`，切句时停止上一段 TTS 避免音频叠加

**改进**

- 备份文件名使用本地时区（`getFullYear/getMonth/...`）替代 UTC，与项目本地时区约定一致
- 通知权限 UI 添加开发模式说明（`import.meta.env.DEV`），提示 WebView2 管理权限
- AnalyticsPage grid 布局改为响应式 `grid-cols-2 sm:grid-cols-3 md:grid-cols-6`，适配 6 维度
- useAnalytics `useRecentSessions` 修正为接收 `filteredRecords`，"近期记录"受 7/30/90 天筛选影响
- FSRS 算法常量添加来源引用注释

**测试**

- **FSRS 算法单元测试**（6 个新增）— 覆盖首评状态转换、lapse 计数、stability 增长、`next_review_at` 本地时区、status 字符串映射、`FsrsState` enum 双向转换

### English

Second-round code review hardening — 26 systematic fixes across security, architecture, error handling, and type safety. Introduces `FsrsState` enum, parameter struct refactoring, `useReducer` state management, `useAbortable` unified cancellation, plus 6 new FSRS algorithm unit tests.

**Security**

- **HTTP permission correction** — `capabilities/default.json` now keeps HTTPS open (users can configure any OpenAI-compatible endpoint) while restricting HTTP to `127.0.0.1` / `localhost` (SSRF prevention). The v1.7.0 fixed domain whitelist broke third-party model configuration (Mistral/Groq/Together AI/self-hosted); corrected
- **Path traversal defense** — `write_text_file` validates against system-sensitive directories (Windows `C:\Windows\` / `C:\Program Files`, Linux `/etc/` `/usr/`, macOS `/System/`), refuses writes and logs `tracing::warn`
- **Whitelist validation expansion** — `update_word_review_fsrs` adds `validate_review_status`; `query_history` adds per-item `validate_record_type`, closing coverage gaps

**Architecture**

- **`FsrsState` enum** (`fsrs.rs`) — `FsrsCard.state` changed from `i64` to `FsrsState` enum (New/Learning/Review/Relearning) with `#[serde(into/from)]` for numeric encoding compatibility; unknown values fall back to New with warning log
- **Parameter struct refactoring** — `db_update_word_review_fsrs` (12 params) and `db_add_word` (10 params) refactored to `FsrsReviewUpdate` / `NewWordInput` structs, eliminating `#[allow(clippy::too_many_arguments)]`
- **`backup_db` non-blocking** — switched to `tokio::task::spawn_blocking`, avoiding holding a pool connection and blocking the async runtime
- **SettingsPage `useReducer`** — 11 voice-setting `useState` calls consolidated into a single `voiceReducer`
- **DashboardPage `useAbortable`** — replaces manual `AbortController`; signal passed through to `getReviewStats` / `getLearningStreak` / `getHistory`

**Error Handling**

- **`handleSaveGoals` atomicity** — `Promise.all` changed to `Promise.allSettled`; on partial failure, does not roll back successful saves but reloads actual values to sync UI with DB
- **SettingsPage initial load** — 5 promises gain `.catch(console.warn)`, avoiding unhandled rejections
- **`getNotificationPermission` return value** — returns `"default"` instead of `"denied"` on error, avoiding misleading "denied" UI
- **useAnalytics `getHistory`** — adds `console.warn` on failure, no longer silently swallowing errors

**Type Safety**

- **SpeakingPage `handleStop` race fix** — `SET_SCORE` action carries `index`; reducer no longer relies on `state.currentIndex`, preventing score misplacement when user switches sentences during async evaluation
- **`handleFinish` zero-score pollution fix** — incomplete sentences marked with `score: null` + `skipped: true` instead of zero-score objects, preventing analytics trend data pollution
- **ReviewPage Zod validation** — `loadReviewSession` uses `SavedReviewSessionSchema` instead of `as` assertion, preventing undefined fields from localStorage tampering
- **`extractJson` type predicate** — adds function overload supporting `(data: unknown) => data is T` type narrowing, no longer degrading to `boolean`
- **use-recording auto-stop fix** — registers `onstop` handler before auto-stop fires, preventing audio data loss and recording state stuck
- **SpeakingPage auto-play cleanup** — useEffect adds `return () => stopTTS()`, stopping previous TTS on sentence switch to avoid audio overlap

**Changed**

- Backup filename uses local timezone (`getFullYear/getMonth/...`) instead of UTC, consistent with project timezone convention
- Notification permission UI adds dev-mode explanation (`import.meta.env.DEV`), clarifying WebView2 permission management
- AnalyticsPage grid layout changed to responsive `grid-cols-2 sm:grid-cols-3 md:grid-cols-6`, fitting 6 dimensions
- useAnalytics `useRecentSessions` corrected to receive `filteredRecords`, "recent sessions" now respects 7/30/90 day filter
- FSRS algorithm constants annotated with source references

**Testing**

- **FSRS algorithm unit tests** (6 new) — covers first-review state transitions, lapse counting, stability growth, `next_review_at` local timezone, status string mapping, `FsrsState` enum bidirectional conversion

---

## v1.7.0

### 中文

代码审查修复版本——35 项跨安全、架构、错误处理、类型安全、资源管理的系统性修复，新增 OS Keychain 集成、r2d2 连接池、tracing 结构化日志、Zod schema 校验，并补充 27 个 Rust 单元测试 + 15 个 `extractJsonSafe` 前端测试。

**安全**

- **HTTP 权限收紧** — `capabilities/default.json` 的 HTTP scope 从 `http://**`（任意 HTTP）收紧为 `127.0.0.1` / `localhost`（本地回环），防止 SSRF 访问内网 HTTP 服务；HTTPS 保持开放以支持用户自定义任意 OpenAI 兼容端点（v1.8.0 修正了固定域名白名单导致第三方模型配置失败的问题）
- **CSV 公式注入防御** — `sanitize_csv_cell` 对以 `=` `+` `-` `@` 开头的单元格前缀单引号，防止 Excel/LibreOffice 将导出字段解释为公式执行
- **Anki 导出 HTML 转义** — 新增 `sanitize_anki_cell` 模块级函数，转义 `&` `<` `>` 并替换 Tab/换行符，防止 Anki 卡片渲染异常或字段错位
- **API Key 不再返回到前端列表** — `get_models` 不再返回 `api_key` 字段；新增独立的 `get_model_api_key` 命令按需读取，编辑模型时才暴露密钥
- **数据库外键约束启用** — `with_init` 添加 `PRAGMA foreign_keys=ON`，强制外键约束

**架构**

- **OS Keychain 集成**（`credentials.rs`）— API Key 不再以明文/Base64 存储在 SQLite，改用 `keyring` crate 写入操作系统原生密钥管理服务（Windows Credential Manager / macOS Keychain / Linux Secret Service）
- **r2d2 连接池**（`db.rs`）— 替换单个 `Mutex<Connection>`，提升并发读取能力；WAL 模式保留
- **tracing 结构化日志**（`lib.rs`）— `init_tracing()` 使用 `tracing_subscriber` + `env-filter`，debug 模式默认 `debug` 级别，release 默认 `info`，可通过 `RUST_LOG` 覆盖
- **commands/ 按领域拆分** — `commands/mod.rs` 拆分为 7 个子模块（`models` / `words` / `history` / `settings` / `learning` / `fsrs` / `export`），shared.rs 提取共享 DTO 类型
- **repository 层分离** — `repository.rs` 承载所有 SQL 查询，commands 仅做参数转发，便于后续替换数据访问实现
- **AppError 结构化错误类型**（`error.rs`）— 自定义 `Serialize` 输出 `{ category, message }` 双字段结构；新增 `From<std::io::Error>` 转换；category 区分 `database` / `credential` / `export` / `io`

**错误处理**

- **Keychain 事务补偿** — `add_model` 改为"先提交 DB 事务、再写 Keychain"策略：若 Keychain 写入失败，删除刚插入的 DB 行作为补偿，避免留下无 Key 的孤儿记录
- **行级错误传播** — `db.rs`、`repository.rs` 中 3 处 `filter_map(|r| r.ok())` 替换为 `collect::<Result<Vec<_>, _>>()?`，行级反序列化错误通过 `AppError::Database` 传播到前端而非被静默丢弃
- **TTS 空值处理** — `db_set_tts_setting` 在 value 为空时调用 `delete_tts_key` 清理 Keychain 残留，而非写入空字符串
- **`db_get_tts_config` 错误记录** — `.ok()` 替换为 `match` + `tracing::warn`，Keychain 读取失败不再被静默吞掉
- **应用启动 unwrap 移除** — `lib.rs` 中 `get_webview_window("main").unwrap()` 和 `default_window_icon().unwrap()` 改为 `ok_or_else` 返回错误，避免启动期 panic
- **FSRS 时区修正** — `chrono::Utc::now()` 改为 `chrono::Local::now()`，复习时间计算使用本地时区
- **备份目标路径校验** — `backup_db` 检查目标路径不存在，防止覆盖已有文件

**类型安全（前端）**

- **Zod schema 校验**（`ExercisePage.tsx` / `ListeningPage.tsx`）— 内联 type guard 替换为 `ExerciseQuestionSchema` / `ListeningSentenceSchema` 的 `safeParse` 校验
- **`extractJsonSafe`**（`parse-utils.ts`）— 新增接受 Zod schema 的 `extractJson<T>(text, schema)` 重载，提供运行时校验；保留 `extractJson` 兼容旧调用方
- **`is_default` 字段补全**（`SettingsPage.tsx` / `lib/db.ts`）— `updateModel` 新增 `is_default: boolean` 参数，编辑模型时可直接设为默认

**资源管理**

- **`useRecording` 闭包陈旧修复** — `maxDurationMs` 通过 `useRef` 同步，避免 setTimeout 捕获旧值导致最大时长限制失效
- **App.tsx 未处理 Promise** — `Promise.all` 添加 `.catch` 输出 warn，避免未处理的 rejection
- **`HistoryPage` refresh 缺 catch** — 添加 `.catch` 防止刷新失败时未处理 rejection
- **`SpeedTrainerPage` 区分 AbortError** — catch 中识别 `AbortError` 避免取消请求被误报为失败
- **`useStreamChat` cleanup 强化** — 新增 `loadingRef` 防止卸载后 setState
- **`getDefaultModelCached` 共享缓存** — `use-graph-data` / `services/llm` / `ReadingPage` 统一使用，避免重复查询

**测试**

- **Rust 单元测试**（27 个）— `repository::tests` 覆盖枚举校验、CSV 净化、Anki HTML 转义；`error::tests` 覆盖 `From` 转换和 `Serialize` 结构
- **前端测试**（新增 15 个，总计 231 个）— `extractJsonSafe` 测试套件覆盖三级回退、schema 校验失败、Zod v4 默认 passthrough 行为、与手写 type guard 等价性

**改进**

- `SettingsPage` 提取 `MIMO_VOICES` 到模块级常量，修复 `useEffect` 依赖数组
- `ReviewPage` 当前复习队列持久化到 localStorage，意外中断后可恢复
- `AnalyticsPage` 支持 7/30/90 天时间范围筛选
- `DashboardPage` 重试按钮改为 `loadDashboard` 而非 `window.location.reload`
- `SpeedTrainerPage` 在 Sidebar 和 App 路由中改名为"语速训练"，消除与 ExercisePage 命名混淆

### English

Code review hardening release — 35 systematic fixes across security, architecture, error handling, type safety, and resource management. Adds OS Keychain integration, r2d2 connection pool, tracing structured logging, Zod schema validation, plus 27 Rust unit tests + 15 new `extractJsonSafe` frontend tests.

**Security**

- **HTTP permission tightening** — `capabilities/default.json` HTTP scope tightened from `http://**` (any HTTP) to `127.0.0.1` / `localhost` (loopback only), preventing SSRF to internal HTTP services; HTTPS remains open to support user-configured OpenAI-compatible endpoints (v1.8.0 corrected the fixed domain whitelist that broke third-party model configuration)
- **CSV formula injection defense** — `sanitize_csv_cell` prefixes cells starting with `=` `+` `-` `@` with a single quote, preventing Excel/LibreOffice from interpreting exported fields as executable formulas
- **Anki export HTML escaping** — new `sanitize_anki_cell` module-level function escapes `&` `<` `>` and replaces Tab/newline, preventing Anki card rendering issues or field misalignment
- **API Key no longer exposed in list views** — `get_models` no longer returns `api_key`; new dedicated `get_model_api_key` command reads on demand when editing
- **Foreign key enforcement** — `with_init` adds `PRAGMA foreign_keys=ON` to enforce FK constraints

**Architecture**

- **OS Keychain integration** (`credentials.rs`) — API Keys no longer stored in SQLite as plaintext/Base64; uses `keyring` crate to write to OS-native key management (Windows Credential Manager / macOS Keychain / Linux Secret Service)
- **r2d2 connection pool** (`db.rs`) — replaces single `Mutex<Connection>` for better read concurrency; WAL mode retained
- **tracing structured logging** (`lib.rs`) — `init_tracing()` uses `tracing_subscriber` + `env-filter`; defaults to `debug` in dev, `info` in release, overridable via `RUST_LOG`
- **commands/ split by domain** — `commands/mod.rs` split into 7 submodules (`models` / `words` / `history` / `settings` / `learning` / `fsrs` / `export`); `shared.rs` extracts common DTO types
- **Repository layer separation** — `repository.rs` owns all SQL queries; commands only forward parameters, easing future data-access implementation swaps
- **AppError structured error type** (`error.rs`) — custom `Serialize` outputs `{ category, message }` two-field structure; adds `From<std::io::Error>` conversion; category distinguishes `database` / `credential` / `export` / `io`

**Error Handling**

- **Keychain transaction compensation** — `add_model` now commits DB transaction first, then writes Keychain; if Keychain write fails, deletes the just-inserted DB row as compensation, avoiding orphan records without keys
- **Row-level error propagation** — 3 `filter_map(|r| r.ok())` calls in `db.rs` and `repository.rs` replaced with `collect::<Result<Vec<_>, _>>()?`, propagating row deserialization errors via `AppError::Database` instead of silently dropping them
- **TTS empty value handling** — `db_set_tts_setting` calls `delete_tts_key` when value is empty to clean up Keychain residue, instead of writing empty string
- **`db_get_tts_config` error logging** — `.ok()` replaced with `match` + `tracing::warn`, no longer silently swallowing Keychain read failures
- **Startup unwrap removal** — `lib.rs` `get_webview_window("main").unwrap()` and `default_window_icon().unwrap()` changed to `ok_or_else` returning errors, avoiding startup panics
- **FSRS timezone fix** — `chrono::Utc::now()` changed to `chrono::Local::now()`, review time calculation now uses local timezone
- **Backup destination check** — `backup_db` verifies destination path doesn't exist, preventing overwriting existing files

**Type Safety (Frontend)**

- **Zod schema validation** (`ExercisePage.tsx` / `ListeningPage.tsx`) — inline type guards replaced with `ExerciseQuestionSchema` / `ListeningSentenceSchema` `safeParse`
- **`extractJsonSafe`** (`parse-utils.ts`) — new `extractJson<T>(text, schema)` overload accepting Zod schema for runtime validation; `extractJson` retained for backward compatibility
- **`is_default` field** (`SettingsPage.tsx` / `lib/db.ts`) — `updateModel` gains `is_default: boolean` parameter; editing a model can now set it as default directly

**Resource Management**

- **`useRecording` stale closure fix** — `maxDurationMs` synced via `useRef`, preventing setTimeout from capturing stale value and breaking max-duration limit
- **App.tsx unhandled Promise** — `Promise.all` gains `.catch` logging warn, avoiding unhandled rejection
- **`HistoryPage` refresh missing catch** — adds `.catch` to prevent unhandled rejection on refresh failure
- **`SpeedTrainerPage` AbortError distinction** — catch identifies `AbortError` to avoid misreporting cancellation as failure
- **`useStreamChat` cleanup hardening** — adds `loadingRef` to prevent setState after unmount
- **`getDefaultModelCached` shared cache** — `use-graph-data` / `services/llm` / `ReadingPage` unified to use the same cache, avoiding duplicate queries

**Testing**

- **Rust unit tests** (27 new) — `repository::tests` covers enum validation, CSV sanitization, Anki HTML escaping; `error::tests` covers `From` conversions and `Serialize` structure
- **Frontend tests** (15 new, 231 total) — `extractJsonSafe` suite covers three-level fallback, schema validation failure, Zod v4 default passthrough behavior, equivalence with hand-written type guards

**Changed**

- `SettingsPage` extracts `MIMO_VOICES` to module-level constant, fixes `useEffect` deps
- `ReviewPage` persists current review queue to localStorage for interruption recovery
- `AnalyticsPage` supports 7/30/90 day time range filter
- `DashboardPage` retry button now calls `loadDashboard` instead of `window.location.reload`
- `SpeedTrainerPage` renamed to "语速训练" in Sidebar and App routes, clearing naming confusion with ExercisePage

---

## v1.6.0

### 中文

口语跟读练习 + 阅读助手 UX 改进 + 数据库索引优化。

**新功能**

- **口语跟读练习**（`SpeakingPage`）— 全新功能，LLM 生成句子 → 用户录音跟读 → ASR 转写 → LLM 评分。支持三种难度（初级/中级/高级）和六个主题（日常对话/商务英语/旅游出行/科技/校园生活/面试自我介绍），每轮 5 句，逐句评分并给出改进建议
- **ASR 语音识别服务**（`src/services/asr.ts`）— 封装 mimo ASR 模型的 Chat Completions 接口，支持 webm → WAV 转码，复用 TTS 配置的 base_url 和 api_key
- **`useRecording` hook** — 封装 MediaRecorder API，提供 start/stop 控制和 recording/loading/error 状态
- **`useRetryHint` hook** — LLM 响应超过 30 秒时显示"重新生成"提示
- **`useLatestRef` hook** — 将频繁变化的值保持在 ref 中，解决闭包陈旧问题
- **口语分析**（`useSpeakingAnalytics`）— 分析口语练习记录，生成得分趋势数据，集成到 AnalyticsPage
- **数据库索引**（`008_add_indexes.sql`）— 为 words 和 history 表添加复合索引，优化复习查询和历史列表查询性能

**改进**

- 阅读助手 UX：分析完成后显示"新文章"按钮，知识图谱生成时显示加载提示
- AnalyticsPage：新增口语得分趋势图，统计卡片覆盖所有学习类型
- Sidebar：新增"口语练习"入口

**修复**

- `GRAPH_SUMMARY_PROMPT` 未导出导致知识图谱页面白屏

### English

Speaking practice + ReadingPage UX improvements + database index optimization.

**New**

- **Speaking practice** (`SpeakingPage`) — LLM generates sentences → user records audio → ASR transcription → LLM scoring. Supports 3 difficulty levels and 6 topics, 5 sentences per round with per-sentence scoring and improvement suggestions
- **ASR service** (`src/services/asr.ts`) — wraps mimo ASR model via Chat Completions API with webm → WAV conversion
- **`useRecording` hook** — wraps MediaRecorder API with start/stop control and recording/loading/error states
- **`useRetryHint` hook** — shows "regenerate" hint when LLM response exceeds 30 seconds
- **`useLatestRef` hook** — keeps frequently changing values in a ref to solve stale closure issues
- **Speaking analytics** (`useSpeakingAnalytics`) — derives speaking score trend data, integrated into AnalyticsPage
- **Database indexes** (`008_add_indexes.sql`) — composite indexes for words and history tables, optimized query performance

**Changed**

- ReadingPage UX: "New Article" button after analysis; knowledge graph loading indicator
- AnalyticsPage: new speaking score trend chart, stat cards cover all learning types
- Sidebar: new "Speaking Practice" entry

**Fixed**

- `GRAPH_SUMMARY_PROMPT` missing export caused knowledge graph white screen

---

## v1.5.2

### 中文

代码质量版本——FSRS 算法修复 + CSV 解析增强 + Anki 导出净化 + 静默失败修复。

**修复**

- **FSRS `elapsed_days` 修复**：根据 `next_review_at` 和 `scheduled_days` 反推真实天数差，间隔重复算法现在能正确判断复习是否准时/延迟/提前
- **CSV 导入增强**：RFC 4180 兼容解析器，支持引号字段内逗号、转义双引号、自动检测 Tab/逗号分隔符
- **Anki 导出净化**：导出前替换 Tab 和换行符，防止 Anki 导入时字段错位
- **HistoryDetailPage 懒加载**：KnowledgeGraph 改为 `React.lazy()` + `<Suspense>`，主 bundle 减少 ~200KB
- **4 处静默失败修复**：CorrectPage 历史写入、ReadingPage 图谱、VocabularyPage 补全、SettingsPage TTS 测试现在均有用户可见的错误提示

**改进**

- Sidebar 导航刷新：修正 v1.5.1 中将 Sidebar 改为 mount-only 加载的错误，恢复每次导航时刷新数据

### English

Code quality release — FSRS algorithm fix, CSV parsing enhancement, Anki export sanitization, and error handling improvements.

**Fixed**

- **Critical: FSRS `elapsed_days` always 0** — `calculateNextReview()` now computes the real elapsed days from `next_review_at` and `scheduled_days` before passing to the Rust FSRS algorithm
- **CSV import field splitting** — RFC 4180-compliant `parseCsvLine()` with quoted fields, escaped double-quotes, and auto-detect delimiter
- **Anki export field sanitization** — Tab and newline replaced with spaces before export to prevent field misalignment
- **HistoryDetailPage bundle size** — `KnowledgeGraph` lazy-loaded with `React.lazy()` + `<Suspense>`
- **Silent failure fixes** — CorrectPage history write, ReadingPage graph, VocabularyPage enrichment, SettingsPage TTS test now show user-facing errors

**Changed**

- Sidebar data refresh on navigation — reverts an incorrect v1.5.1 optimization; badges and progress bars now update after reviews and exercises

---

## v1.5.1

### 中文

质量加固版本——全面代码审查修复 + OnboardingDialog 重写。

**严重修复**

- `useStreamChat` abort 竞态：abort 在 model lookup 期间触发时任务状态卡在 "running"
- `createCachedFetcher` 内存泄漏：缓存驱逐时 blob URL 未释放
- `createCachedFetcher` 过早清理：`invalidate()` 对 pending promise 的 onEvict 时序错误
- LLM 流末尾 token 丢失：stream 结束时未 flush 剩余 buffer
- SpeedTrainerPage `loopMode` 闭包陈旧：异步循环读取 ref 而非 captured state
- ListeningPage `difficulty` 闭包陈旧：`generateSentences` 读取 ref

**主要修复**

- `useAudioPlayer` 非原子状态切换
- `extractJson` 花括号内字符串误匹配
- SettingsPage 6 个异步 handler 缺少错误处理
- VocabularyPage 批量补全闭包陈旧
- VocabularyPage CSV 导入 O(n*m) 性能问题
- ListeningPage 卸载时未 abort
- ExerciseCard button/div 动态标签改为 always-button
- `streamChat` 无超时：新增 120s 默认超时
- `enrichWord` 无 AbortSignal：新增可选 signal 参数
- 通知重复发送：调整 `setSetting` 时序
- `smartFetch` 错误掩盖：缩小 catch 范围

**次要修复**

- `usePhaseMachine.isPhase` 稳定性
- `usePhaseMachine` 同 phase 转移保护
- `getReviewStats` 空表安全
- VocabularySection 渲染优化 + 重复检测
- AnalyticsPage 排序和颜色修复
- ErrorBanner 关闭按钮
- ExerciseCard 无障碍属性

**增强**

- OnboardingDialog 重写：shadcn/ui Dialog 组件，内置 focus trap、scroll lock、ARIA 属性和动画

### English

Quality hardening release — comprehensive code review fixes and OnboardingDialog rewrite.

**Critical Fixes**

- `useStreamChat` abort race condition — task status stuck in "running" when abort fires during model lookup
- `createCachedFetcher` memory leak — blob URLs not released on cache eviction
- `createCachedFetcher` premature cleanup — `invalidate()` onEvict timing error for pending promises
- LLM stream last-token drop — remaining buffer not flushed when stream ends
- SpeedTrainerPage `loopMode` stale closure — async loop reads from ref instead of captured state
- ListeningPage `difficulty` stale closure — `generateSentences` reads from ref

**Major Fixes**

- `useAudioPlayer` non-atomic state transition
- `extractJson` brace-in-string bug
- SettingsPage missing error handling on all 6 async handlers
- VocabularyPage batch enrichment stale closure
- VocabularyPage CSV import O(n*m) performance
- ListeningPage unmount abort missing
- ExerciseCard button/div anti-pattern replaced with always-button
- `streamChat` no timeout — added 120s default
- `enrichWord` no AbortSignal — added optional signal parameter
- Notification duplicate send — adjusted `setSetting` timing
- `smartFetch` error masking — narrowed catch scope

**Minor Fixes**

- `usePhaseMachine.isPhase` stability
- `usePhaseMachine` same-phase guard
- `getReviewStats` null safety
- VocabularySection render optimization + duplicate detection
- AnalyticsPage sort and color fixes
- ErrorBanner dismiss button
- ExerciseCard accessibility attributes

**Enhancement**

- OnboardingDialog rewrite — shadcn/ui Dialog with focus trap, scroll lock, ARIA attributes, and animations

---

## v1.5.0

### 中文

设计模式重构第二轮——引入可复用 hook、共享 UI 组件、集中式类型注册表，修复竞态条件，并完成代码审查修复。

**新功能**

- `useAudioPlayer` Hook：提取 TTS 播放的通用 hook，封装 AbortController 生命周期和 playing/loading 状态
- `usePhaseMachine` Hook：泛型阶段状态机，支持 `onEnter`/`onExit` 回调
- `createCachedFetcher` 工具：泛型异步缓存，支持 Promise 去重 + FIFO 驱逐 + 手动失效
- `EmptyState`、`ErrorBanner`、`LoadingIndicator` 共享 UI 组件
- `DETAIL_COMPONENTS` 注册表模式替代 4 层三元链
- 15 个新单元测试，总计 65 个测试全部通过

**改进**

- SpeakButton 从 79 行精简至 42 行
- SpeedTrainerPage 竞态修复：generation counter 替代 `stoppedRef` + 3 个 `setTimeout` hack
- 注释补全：为 10 个文件补充详细 JSDoc 和行内注释
- 生词自动补全：从阅读页面添加生词时自动 LLM 补全
- 新用户引导：首次启动 4 步引导对话框
- 分析面板扩展：覆盖所有学习类型
- 学习 streak 与复习提醒
- 写作批改加入生词本
- AI 个性化 prompt
- 每日复习通知
- 手动添加生词 + CSV 批量导入
- 页面级测试：38 个新测试，总计 103 个测试全部通过
- 听力闭环补全：错误句子提取词汇加入生词本
- 每日学习目标与进度条
- 学习画像雷达图

**修复**

- `playAudio` abort 时 Promise 永不 settle 的内存泄漏
- `createCachedFetcher` 永久缓存失败请求导致无法重试
- `fetchGraphData` 无法取消的竞态条件
- `useStreamChat` options 依赖导致 execute 重复创建
- ReadingPage addWord 失败 UI 卡死
- CorrectPage notes 数据丢失
- `recordLearningActivity` 竞态条件
- 批量补全卸载泄漏
- 新手引导误关闭
- ListeningPage 重试阻塞
- ReadingPage 语言检测无 AbortSignal
- useStreamChat 状态闪烁
- VocabularyPage 定时器泄漏
- SpeedTrainer 语速闭包陈旧
- CorrectPage addedWords 闭包问题

### English

Design patterns refactoring — second pass. Reusable hooks, shared UI components, centralized type registry, race condition fixes, comprehensive documentation, and 5 product improvements.

**New**

- `useAudioPlayer` hook — shared TTS playback hook with AbortController lifecycle and playing/loading states
- `usePhaseMachine` hook — generic phase-based state machine with `onEnter`/`onExit` callbacks
- `createCachedFetcher` utility — generic async cache with Promise deduplication, FIFO eviction, and manual invalidation
- `EmptyState`, `ErrorBanner`, `LoadingIndicator` shared UI components
- `DETAIL_COMPONENTS` registry pattern replacing 4-level ternary chain
- 15 new unit tests, 65 total all passing

**Changed**

- SpeakButton reduced from 79 to 42 lines
- SpeedTrainerPage race condition fixed with generation counter pattern
- Comprehensive JSDoc and inline comments for 10 files
- Vocabulary auto-enrichment from ReadingPage
- New user onboarding — 4-step wizard dialog
- Expanded analytics covering all learning types
- Learning streak & review reminder
- Writing correction → vocabulary integration
- AI personalized prompts
- Daily review notification
- Manual vocabulary entry + CSV batch import
- Page-level tests: 38 new, 103 total all passing
- Listening vocabulary extraction from wrong sentences
- Daily learning goals & progress bars
- Learning profile radar chart

**Fixed**

- `playAudio` Promise leak on abort (never settled)
- `createCachedFetcher` permanently cached rejected Promises (no retry)
- `fetchGraphData` uncancellable graph fetch race condition
- `useStreamChat` options dependency causing `execute` recreation
- ReadingPage addWord failure UI stuck
- CorrectPage notes data loss
- `recordLearningActivity` read-modify-write race condition
- Batch enrichment unmount leak
- Onboarding dialog dismiss bug
- ListeningPage retry blocked
- ReadingPage language detection missing AbortSignal
- useStreamChat double task-status emission
- VocabularyPage timer leak
- SpeedTrainer stale speed closure
- CorrectPage addedWords stale closure

---

## v1.4.0

### 中文

代码架构重构，引入设计模式消除技术债务。

- `useStreamChat` Hook：提取共享的 LLM 流式调用逻辑，4 个 LLM 页面各减少 ~40 行样板代码
- `extractJson<T>()`：统一 JSON 解析工具，三级回退策略，替代了 5 处分散的内联实现
- `smartFetch`：提取 Tauri/WebView 双通道 fetch 策略为共享工具
- `addHistorySafe`：统一历史记录写入的错误处理
- TTS 配置缓存：SpeakButton 点击不再触发 4 条并行 SQL 查询
- `addModel` 事务保护：模型插入 + 默认设置包裹在 BEGIN/COMMIT/ROLLBACK 中
- ExerciseCard 和 VocabularySection 提取为共享组件
- `parseSections` 从 llm.ts 迁移至 parse-utils.ts
- 新增 13 个单元测试，总计 50 个测试用例全部通过

### English

Architecture refactoring — design patterns applied to eliminate technical debt.

- `useStreamChat` Hook — shared LLM streaming logic, ~40 lines of boilerplate removed per page
- `extractJson<T>()` — unified JSON parser with 3-level fallback, replaces 5 inline implementations
- `smartFetch` — Tauri/WebView dual-fetch strategy as shared utility
- `addHistorySafe` — unified error handling for history writes
- TTS config caching — SpeakButton clicks no longer trigger 4 parallel SQL queries
- `addModel` transaction safety — model insert + default set wrapped in BEGIN/COMMIT/ROLLBACK
- ExerciseCard and VocabularySection extracted as shared components
- `parseSections` relocated from llm.ts to parse-utils.ts
- 13 new unit tests, 50 total all passing

---

## v1.3.0

### 中文

- TTS 语音合成集成：支持 OpenAI 兼容的 TTS API，可独立配置 API 地址、密钥、音色和语速
- 词汇发音：生词本和复习页面每个单词旁添加发音按钮
- 阅读朗读：逐句朗读原文，当前句子高亮同步
- 写作对比听：每条纠错的原文和修正均可分别播放
- 听力练习：全新功能，LLM 生成句子 → TTS 播放 → 用户听写 → 自动评分
- 语速训练器：全新功能，五档语速（0.5x-1.5x）播放，支持单句/全文循环
- 设置页新增 TTS 配置卡片，含测试语音功能

### English

- TTS integration — OpenAI-compatible TTS API with independent config for URL, key, voice, and speed
- Vocabulary pronunciation — speaker button on every word in vocabulary notebook and review flashcards
- Reading read-aloud — sentence-by-sentence playback with synchronized highlighting
- Writing compare-speak — listen to both original and corrected text for each correction
- Listening practice — LLM generates sentences, TTS plays, user dictates, auto-scoring
- Speed trainer — paste English text and play at 5 speed levels (0.5x–1.5x) with single/full loop modes
- Settings page TTS configuration card with test button

---

## v1.2.1

### 中文

- 弱项训练功能增强：支持按题型智能判分（填空题精确匹配，改错/重写题归一化匹配）
- 加载超时提示：LLM 响应超过 30 秒时显示"重新生成"按钮
- 保存失败反馈：练习结果写入数据库失败时显示警告横幅
- 任务状态栏集成：弱项训练任务现在会在顶部状态栏显示加载/完成状态
- 代码质量：全面补充注释，新增单元测试（32 个测试用例）

### English

- Enhanced weak point training: smart answer matching by question type
- Loading timeout hint: shows "regenerate" button when LLM takes over 30 seconds
- Save failure feedback: warning banner when exercise results fail to persist
- Task status bar integration: weak point training shows loading/completion in global status bar
- Code quality: comprehensive comments, new unit tests (32 test cases)

---

## v1.1.0

### 中文

- 弱项训练：基于写作批改数据自动识别薄弱环节，生成针对性练习题
- 分析面板增强：新增弱项训练推荐，点击可直接进入练习
- 历史详情支持练习记录回看

### English

- Weak point training: automatically identifies weak areas from writing correction data and generates targeted exercises
- Analytics dashboard: new weak category recommendation with direct training access
- History detail supports exercise record review
