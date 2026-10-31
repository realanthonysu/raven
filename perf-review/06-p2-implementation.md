# P2 性能修复落地记录

- **执行日期**：2026-10-31
- **基线**：P1 提交 `69c9c34`（`perf: 落地性能审查 P1 清单——…`）
- **依据**：[00-performance-analysis.md](00-performance-analysis.md) 第 2 节 P2 清单
- **状态**：可本地安全实施的 P2 项全部落地；结构性/高风险项明确保留并给出后续建议。未提交 git（工作区保留改动）。

---

## 1. 结果总览

### 1.1 已落地

| 领域 | 项 | 结果 |
| --- | --- | --- |
| 数据层 | D-04 历史多类型查询临时排序 | 多类型 `UNION ALL` 子查询 + 外层全局排序分页；结果查询同样 |
| 数据层 | D-05 词库搜索/预检 | 新增 `db_word_exists`（lower(word) 索引等值）；LIKE 搜索转义 `%/_/\` + `ESCAPE`；加词预检不再拉 500 条 DTO |
| 数据层 | D-06 复习队列/统计扫描 | 迁移 015 部分索引 `idx_words_due`；`get_review_words` 改 new/其余未掌握两分支 UNION ALL，移除 CASE 排序 |
| 数据层 | D-08 导出双 IPC | 新增 `db_export_words_dialog(kind)`：Rust 内查库生成 CSV/Anki + 原生保存对话框 + 写盘；前端 `exportWordsDialog` |
| 启动 | S-03 OnboardingDialog 静态入口 | `App.tsx` 改为 lazy，仅首启显示时加载；局部 Suspense |
| 启动 | S-04 顶层 Suspense 全壳替换 | 页面级 Suspense 下移到 `Layout` 的 `<Outlet/>`，Sidebar/状态栏首帧即渲染 |
| 流式 | S-07 每 token 一次 Channel 事件 | Rust `TokenBatch`：同网络 chunk 的增量合并为一条 Token 事件（阈值 16 KB），结束/`[DONE]` 先 flush 再 Done |
| 流式 | S-08 Done 重复携带全文 | `ProxyEvent::Done` 无字段；Rust 不再持有全文（仅字节计数），前端用本地累积 |
| 流式 | S-09 无换行长行 O(n²) 重扫 | `extract_lines(buffer, &mut scan_from)` 跨 chunk 增量扫描；CR/CRLF 跨块语义保留 |
| 流式 | S-10 testLLMConnection 无超时 | 改 `guardedInvoke`：signal + 20s 前端超时，同值下发 Rust |
| 流式 | S-11 阅读提交前串行语言检测 | 本地明显英文快速判定（Unicode 字母数、ASCII 占比、功能词），其余回落 LLM |
| TTS | S-13 TTS 配置/DNS 重复 | Rust `TtsConfigCache`（5min TTL + 写路径失效，含中毒容错）；SSRF DNS 校验缓存（120s、≤64 域、只缓存已通过校验 IP、命中复检） |
| TTS | S-14 TTS 缓存只按条数 | `createCachedFetcher` 支持 `maxTotalBytes`/`sizeOf`；TTS 音频缓存 32 MB 预算，淘汰 revoke object URL |
| Analytics | H-02 时间戳重复解析 | 新增 `RecordTimeIndex`（id→时间戳/日期标签），编排层建一次、时间范围切换零 parse（测试锁定） |
| Analytics | H-03/P-08 局部状态全图重渲 | 错题本状态下沉 memo 组件；`ScoreTrendChart` memo；`formatValue` 模块级；`categoryNodes`/LevelProgressCard 派生 memo |
| Analytics | H-04 写作聚合重算 | `useWritingAnalytics` 聚合/趋势统一 `useMemo([parsed])` |
| History | H-16 删除后全量重拉 | 删除后本地 filter 移除，不再 `getHistoryList(records.length+PAGE_SIZE)` |
| History | H-17 列表渲染 | 卡片 `content-visibility:auto` + `contain-intrinsic-size`；日期模块级 `Intl.DateTimeFormat` + Map 缓存 |
| History | H-18 详情一次性渲染 | `graph_data` 改为展开图谱时再拉取/解析；阅读分节仅首节默认展开 |
| Correct | H-21 纠错卡重渲 | 单条纠错抽 `CorrectionItem = memo`，回调稳定；测试用 SpeakButton 渲染计数验证 |
| Review | H-22 localStorage 全量 words | 只持久化 `wordIds + currentIndex + results`；恢复按 id 重查；兼容旧格式读取 |
| 外壳 | P-04 ResultCard 折叠卸载子树 | 新增 `keepMounted`（首次展开后常驻、`hidden` 折叠）；ReadingPage 六维 Markdown/图谱卡启用 |
| 外壳 | P-05 持久化壳订阅扇出 | `getTaskState()` 非订阅读取；TTL 守卫不再订阅 taskStatus；PageVisibility value 按命中的持久化路由派生；常驻页 memo |
| 练习 | P-06 生成阶段空转 20fps | `useLLMStreamPage` 新增 `flushResult`（默认 true）；`usePracticeSession` 传 false，最终文本仍经 onDone/persistResult |
| 图谱 | H-07 ResizeObserver 高频 fit | 同帧 resize 用 rAF 合并；fit trailing ~120ms 去抖一次；expanded/data 立即 resize 保留 |
| 生词本 | H-12/P-09 100 张词卡重渲 | `WordCard`/`VocabularyList` 双 memo + 回调 `useCallback` + `hasPendingEnrichment` memo；批量进度/搜索不重渲词卡 |
| Dashboard | H-15 每次回首页重复加载 | 整个 Dashboard 派生数据（查询 + result 解析 + 弱项聚合）5s TTL 缓存；重试显式失效 |
| 启动 | D-07/S-05 重复聚合查询 | `getSidebarData` 改 5s TTL + Promise 去重共享快照；Sidebar/Dashboard/通知/GoalsProvider 共用；打卡/目标写入立即失效 |
| 媒体 | S-15/WAV 主线程编码 | 混音/编码改索引循环 + 预分配 + Int16Array 直写；已是 wav 的 Blob 直通不重编码 |

### 1.2 保留（明确不本轮实施）

| 项 | 结论 | 理由 |
| --- | --- | --- |
| S-02 首屏 zod | 保留 | 首屏 zod 来自 `lib/db` barrel → `settings.ts`/`learning.ts`/`history.ts` 三条 eager 路径；需拆 `placement` 懒模块 + learning 结构化 DTO + history 解析拆分，跨多个模块边界，且会改动数据层契约；建议单独任务 |
| D-09 result 窗口字节预算 | 保留 | SQL 可行，但会把「最近 150 条」变成数据依赖窗口，需同步改 Analytics 统计口径/披露文案；属产品可见语义变更，应先测量真实 result 分布再决策 |
| H-01 Analytics 两阶段渲染 | 保留 | 需要拆 `useHistoryWindow` 单次加载为「元数据 → result 解析」两阶段并给图表加占位，改动 `AnalyticsData` 契约与测试口径，中高风险 |
| H-08 隐藏页驻留 DOM/Cytoscape | 保留 | 已有 10 分钟 TTL 卸载；P-04 keepMounted 只影响「用户主动展开过的图谱/长 Markdown」，且折叠时不可见；进一步按隐藏时长卸载 Cytoscape 会牺牲返回时的布局恢复体验，留作独立评估 |
| S-16 ASR base64 跨 IPC | 保留 | 当前 Tauri 命令是「多参数 + JSON 参数」签名，改原始字节需引入 `Request` 原始 body 的专用上传命令/临时文件协议，改动面大于本轮收益；S-15 已削减主线程编码成本，base64 本身是 mimo API 的请求格式要求 |

> P1 已完成的 H-06、P-03、H-19（WAV 编码）等不再重复；H-19 由 S-15 覆盖。

---

## 2. 关键验证

| 命令 | 结果 |
| --- | --- |
| `npm test` | **111 files / 1661 tests passed**（0 failed） |
| `npx tsc --noEmit -p tsconfig.app.json` / `npm run build` | 通过（`tsc -b && vite build` 成功） |
| `npm run lint`（biome check） | **278 files checked，无错误** |
| `cargo test --lib` | **292 passed / 0 failed** |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `cargo fmt -- --check` | 通过 |
| `git diff --check` | 通过 |

### 首屏包体（P2 前后）

| 指标 | P1 提交后 | P2 完成后 |
| --- | ---: | ---: |
| `dist/index.html` 首屏 preload（JS+CSS） | 550,746 B | **451,699 B** |
| 首屏 gzip（构建输出汇总，约） | ~168 KB | **~135 KB** |
| 首屏 chunk | index / vendor-utils / vendor-react / button / target / error-utils / fetch-utils / create-store / task-status | index / vendor-utils / vendor-react / create-store / CSS |

P2 减少约 **99 KB raw / 33 KB gzip**；`vendor-charts` 仍保持按需加载（P1 成果）。`OnboardingDialog` 独立 chunk（20.6 KB）不再首屏。

### 新增/变更的 Rust 接口

- 新命令：`db_word_exists`、`db_export_words_dialog`（已注册 `lib.rs`）。
- 新 State：`commands::proxy::TtsConfigCache`（已 `app.manage`）。
- 新迁移：`015_partial_due_index.sql`（已在 `db.rs` MIGRATIONS 注册，版本 15；`AGENTS.md` 迁移清单已补）。
- 既有命令签名变化：`fetch_tts_audio` / `transcribe_audio` / `db_set_tts_settings_batch` / `db_set_setting` 增加 `State<TtsConfigCache>`（invoke 参数不变）。

### 主要行为变化

1. Dashboard 的 streak 不再独立降级为 0：`getSidebarData` 属核心查询，失败整页报错（与 reviewStats 原核心语义一致）。
2. `getSidebarData` 5s 缓存：Sidebar 导航刷新在窗口内可能拿到 ≤5s 旧值；打卡/目标写入立即失效，词库写依赖 TTL 收敛。
3. TTS 音频缓存淘汰策略由「200 条」改为「32 MB 总字节 + FIFO」；正在播放的旧条目理论上可能被淘汰（与旧 maxSize FIFO 同性质，刚解析条目不因自身插入被淘汰）。
4. SSE Token 事件现在是「同 chunk 批量字符串」，前端 `onToken` 语义不变；Done 无 fullText。
5. ReadingPage 六维 Markdown/图谱卡首次展开后常驻（折叠用 `hidden`），重新展开不重建 Cytoscape/Markdown。
6. CSV/Anki 导出新增单 IPC 命令，但 VocabularyPage 尚未切换到新命令（保留旧导出路径；页面切换属后续 UI 工作）。
7. H-02 范围外仍有残留：`lib/level-estimation-samples.ts` 与 `lib/exercise-stats.ts` 内部自行 `parseDbTimestamp`，切换时间范围时仍会重解析（建议后续把时间戳作为参数传入）。

---

## 3. 变更文件概览

**Rust / 迁移**
- `src-tauri/migrations/015_partial_due_index.sql`（新）
- `src-tauri/src/db.rs`、`lib.rs`
- `src-tauri/src/commands/{export,proxy,sse,ssrf,settings,words,history}.rs`
- `src-tauri/src/repository/{history,words}.rs`

**前端数据/服务**
- `src/lib/db/{learning,export,index,words}.ts`、`src/lib/cache.ts`、`src/lib/task-status.ts`、`src/lib/word-utils.ts`
- `src/services/{llm,tts,asr,notifications}.ts`
- `src/hooks/{use-llm-stream-page,use-practice-session,use-language-detection,use-add-to-vocabulary,use-read-aloud}.ts`
- `src/hooks/use-analytics/**`、新增 `src/hooks/use-analytics/record-time-index.ts`

**前端页面/组件**
- `src/App.tsx`、`src/components/{Layout,PersistentRoutes,ResultCard,Sidebar}.tsx`、`src/contexts/{PageVisibilityContext,GoalsContext}.tsx`
- `src/components/analytics/LevelProgressCard.tsx`、`src/components/knowledge-graph/use-cytoscape-graph.ts`
- `src/pages/{AnalyticsPage,HistoryPage,HistoryDetailPage,CorrectPage,ReviewPage,VocabularyPage,DashboardPage,ReadingPage}.tsx`
- `src/pages/vocabulary/use-add-word.ts`

**测试**：上述模块对应测试 + 新增 `src/App.test.tsx`、`src/components/ResultCard.test.tsx`、`src/contexts/PageVisibilityContext.test.tsx`、`src/lib/db/export.test.ts`。

**文档**：`AGENTS.md`（迁移 015、命令清单、Dashboard 共享快照、cache 字节预算、flushResult）。

---

## 4. 后续建议

1. **S-02**：把 `getPlacementResult`/`PlacementResultSchema` 拆到独立懒模块并从 db barrel 移除；`getSidebarData.today_activities` 改 Rust 结构化 DTO；历史 result 解析延后。完成后用 `dist/index.html` 的 preload 列表验证 zod 不再首屏。
2. **S-16**：如确需去掉 ASR base64 的 IPC 拷贝，设计 `Request` 原始 body 上传命令 + 临时文件协议，单独评估移动端兼容性（Tauri 文档注明 Android 不支持 Raw body）。
3. **D-09/H-01**：先测量真实 `result` 长度分布与 Analytics 首屏解析耗时，再决定字节预算/两阶段渲染。
4. **H-02 残留**：把 `parseDbTimestamp` 的结果作为参数传入 `level-estimation-samples` / `exercise-stats`，使「切换时间范围零解析」覆盖全部派生。
5. **导出 UI**：VocabularyPage 可切到 `exportWordsDialog`，删除旧的「Rust 生成 → WebView → Rust 写盘」双 IPC 路径（保留旧命令兼容）。

---

*本报告基于 2026-10-31 工作副本；所有耗时/内存数字除构建产物与测试计数外均为静态分析与构建产物测量，未在真实 UI 中做端到端 Profiler 实测。*
