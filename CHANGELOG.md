# Changelog / 更新日志

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
