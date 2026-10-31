# Raven 性能瓶颈分析报告（汇总）

- **分析对象**：Raven v1.9.0（Tauri v2 + React 19 + TypeScript + Rust/rusqlite）
- **代码规模**：前端 `src/` 约 4.5 万行 TS/TSX，Rust `src-tauri/` 约 0.9 万行
- **分析日期**：2026-10-31
- **分析方式**：4 个维度并行做只读代码审查（前端渲染/hooks、数据层/Rust/SQLite、流式服务/启动包体、页面热路径），逐条回读源码核对；SQL 索引结论基于真实迁移建库的 `EXPLAIN QUERY PLAN` 探针；包体结论基于仓库内 `dist/` 构建产物实测大小。**未修改任何源码**。
- **详细分报告**：
  - [01 前端 React 渲染与 hooks](01-frontend-rendering.md)
  - [02 数据访问层与 Rust/SQLite](02-data-backend.md)
  - [03 流式服务与启动包体](03-streaming-services.md)
  - [04 重点页面热路径](04-pages-hotpaths.md)
- **P1 落地记录**：[05-p1-implementation.md](05-p1-implementation.md)（10 项 P1 已全部实施并通过完整测试/构建验证）
- **P2 落地记录**：[06-p2-implementation.md](06-p2-implementation.md)（可安全实施的 P2 项已落地；S-02/S-16/D-09/H-01/H-08 保留并说明原因）

---

## 0. 结论（TL;DR）

**存在性能瓶颈，但没有 P0 级（阻断功能/常规必现严重卡顿）问题。** 共确认：

- **P1：10 项** —— 特定数据量、长文本或特定操作下用户可感知；
- **P2：约 30 项** —— 轻微或规模敏感优化；
- **Info / 已排除：20+ 项** —— 已做过优化、看似热点但实际不成立的部分（见第 5 节）。

最值得优先处理的是 **“投入小、收益直接”** 的 5 项：

1. **首屏多加载 424 KB 的 recharts**：`vendor-charts` 分组把 `clsx` 一起吞了，入口/按钮组件静态依赖该 chunk，`dist/index.html:10` 每次冷启动都 preload（S-01）。
2. **历史列表窗口携带完整 `input_text`**：Analytics/设置页拉 500 条记录时把每条原文整段跨 IPC，实际只消费前 60 个字符（D-01）。
3. **生词本全量加载、每次单条修改都全量刷新**：5k 词约 2.16 MiB、10k 词约 4.32 MiB 的 IPC + 主线程解析，每次删词/改等级都重来一遍（D-02）。
4. **ReadingPage 原文逐词 `<button>` 列表在朗读切句时整篇重建**：长文每次切句重渲染数千个按钮（H-05/P-01）。
5. **TTS 朗读逐句串行合成**：下一句要等上一句“合成完成 + 播放结束”才发请求，20 句文章累计多出约 10–30 秒句间空白（S-12）。

其次是三个“结构性”问题：**批量补全/CSV 导入逐词串行 LLM + IPC**（D-03/S-17）、**abort 不会取消 Rust 侧请求，旧请求最长继续生成 120 秒**（S-06）、**设置页 LevelCard 无条件拉取 Analytics 级历史窗口**（P-02）。

**总体评价**：项目已经落地了大量正确的性能设计（50ms 流式批量 flush、路由懒加载、Cytoscape 实例复用、SQLite WAL/索引、Keychain 缓存、TTS 原始字节返回、列表查询排除 `result`/`graph_data` 等）。当前瓶颈主要不是“没有优化”，而是**数据规模增长后的载荷控制**（全量列表 / 大字段 / 无分页）与**串行编排**（逐词 LLM、逐句 TTS、逐条 IPC）。

---

## 1. P1 清单（建议优先排期）

| # | 编号 | 领域 | 瓶颈 | 关键证据 | 触发条件 / 量级 |
| - | --- | --- | --- | --- | --- |
| 1 | S-01 | 启动包体 | `vendor-charts`（recharts 424,550 B raw / 118,209 B gzip）被 `clsx` 拖成首屏静态依赖，每次冷启动 preload | `vite.config.ts:37-63`；`src/lib/utils.ts:1`；`dist/index.html:10`；`dist/assets/button-BzTEq-HL.js:1` | 每次冷启动；首屏 raw 约 972 KB / gzip 285 KB，其中 43.7% 是未使用的图表库 |
| 2 | D-01 | 数据/IPC | `get_history_list` 返回完整 `input_text`（单条上限 1 MB），Analytics/Settings 的 500 条窗口全量跨 IPC | `src-tauri/src/repository/history.rs:75,96`；`src/lib/db/history.ts:129-130`；`src/hooks/use-analytics/use-recent-sessions.ts:69` | 每次进入 Analytics/设置；500×3 KB≈1.5 MiB、×10 KB≈5 MiB |
| 3 | D-02 | 数据/IPC | 生词本 `getWords(limit=None)` 返回整表（19 字段含 FSRS），任意单条增删改后全量刷新；搜索态再拉一份全量统计 | `src-tauri/src/repository/words.rs:93-122`；`src/pages/VocabularyPage.tsx:162,189,205-208` | 词库 5k≈2.16 MiB、10k≈4.32 MiB；每次改等级/删除/补全都重拉 |
| 4 | D-03 / H-11 / S-17 | 批量导入 | CSV/TXT 导入逐行 `addWord`（每行 1 个 `BEGIN IMMEDIATE` 事务）+ 缺释义时逐词 LLM，严格串行 | `src/pages/vocabulary/use-vocabulary-import.ts:102-159`；`src/pages/vocabulary/batch-processor.ts:36-71`；`src-tauri/src/repository/words.rs:34` | 1000 行≈1000 次 IPC/事务；500 行无释义最坏 8–80 分钟 |
| 5 | H-10 / S-17 | 批量补全 | 批量补全逐词串行 LLM，无并发池/速率控制；在途请求未接 `AbortSignal` | `src/pages/vocabulary/use-batch-enrich.ts:54-66`；`src/services/vocabulary-enrichment.ts:32-44,83-96` | 100 词约 2–15 分钟，500 词数十分钟 |
| 6 | H-05 / P-01 | 页面渲染 | ReadingPage 原文把每个词渲染成 `<button>`；朗读切句或分析后编辑输入会整篇重建（每句重新 split） | `src/pages/ReadingPage.tsx:99-133,200,355-359`；`src/hooks/use-read-aloud.ts:47-51` | 2000 词≈3000–4000 个按钮，每句切换全量 reconcile |
| 7 | P-02 | 页面/数据 | 设置页 `LevelCard` 每次挂载都拉 500 条历史元数据 + 150 条重型 result 并在主线程 Zod 解析（无跨挂载缓存） | `src/pages/settings/LevelCard.tsx:31-32`；`src/hooks/use-level-estimation.ts:42-48`；`src/hooks/use-history-window.ts:69-99` | 每次打开设置；150 条 result≈0.3–1.2 MB 解析 |
| 8 | H-20 / P-07 | 页面渲染 | CorrectPage 流式预览每 50ms 渲染**完整累积 JSON**，没有复用 ReadingPage 的 2000 字符尾部截断 | `src/pages/CorrectPage.tsx:51-57,276`；对照 `src/pages/ReadingPage.tsx:57-68` | 长文纠错（长结果）；典型 3–10 KB，长文数十 KB 时放大 |
| 9 | S-06 | 流式/取消 | 前端 abort 只停止本地事件处理；Rust `pump_sse_stream` 继续读上游并发送 token，最长跑满 120s 超时 | `src/services/llm.ts:246-312`；`src/hooks/use-stream-chat.ts:229-241`；`src-tauri/src/commands/sse.rs:188-193`；`proxy.rs:287-333` | 用户点“停止”/重新提交/切换页面；额外 token 计费与 CPU 占用 |
| 10 | S-12 | TTS | 朗读逐句“合成完 → 播完 → 再合成下一句”，无预取；`playAudio` 在 `onended` 才 resolve | `src/hooks/use-read-aloud.ts:47-52`；`src/services/tts.ts:258-273`；`src/hooks/use-audio-player.ts:142-200` | 20 句文章累计多出约 10–30 秒句间停顿 |

> 级别口径：P0=常规用户必现的严重卡顿/内存问题；P1=特定数据量、长文本或特定操作下可感知；P2=轻微或规模化后才会显现；Info=已优化或无需处理。以上均为静态代码证据，实际耗时需按第 6 节测量确认。

---

## 2. P2 清单（按主题归类）

### 2.1 数据层与 IPC

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| D-04 | 历史多类型 `IN` 查询需要 `USE TEMP B-TREE FOR ORDER BY` | `src-tauri/src/repository/history.rs:123-141,253-285` | 多类型查询不是 O(LIMIT)；20k 行实测约 2.4 ms vs 强制 `idx_history_created` 0.5 ms |
| D-05 | 词库搜索 `lower(col) LIKE '%kw%'` 三列全表扫描 | `src-tauri/src/repository/words.rs:99-118` | `idx_words_word_lower` 只支持等值；预检最多回传 500 条完整 DTO |
| D-06 | 复习队列/统计全表扫描 + 临时排序 | `src-tauri/src/repository/words.rs:184-220` | `review_status != 'mastered'` 与 `ORDER BY CASE` 使 `idx_words_review` 只能覆盖扫描 |
| D-07 / S-05 | 启动期重复查询：review stats ×3、streak ×2、goals ×2；通知链 3–4 次串行 IPC | `src/components/Sidebar.tsx:87-117`；`src/pages/DashboardPage.tsx:149-172`；`src/services/notifications.ts:31-64`；`src/contexts/GoalsContext.tsx:66-68` | 冷启动约 14 次 invoke，重复读取同一聚合数据 |
| D-08 | 导出 CSV 两次跨 IPC（Rust→WebView→Rust） | `src/lib/db/export.ts:8-10`；`src/pages/VocabularyPage.tsx:338-347`；`src-tauri/src/commands/export.rs:111-137` | 1–3 MB 文件双份序列化/内存副本 |
| D-09 | 历史窗口只限条数、不限总字节 | `src/lib/db/history.ts:129-130`；`src-tauri/src/repository/history.rs:35-56` | 理论上限 150×5 MB / 500×1 MB；极端数据内存风险（疑似） |

### 2.2 启动与包体

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| S-02 | 首屏共享 chunk 含完整 zod 运行时（约 103 KB raw / 30.7 KB gzip） | `src/lib/db/settings.ts:13-15`；`src/lib/db/learning.ts:6,85`；`dist/assets/error-utils-*.js` | `getPlacementResult`/`DailyActivitiesSchema` 模块级导入把 zod 拉进首屏 |
| S-03 | `OnboardingDialog` 及 6 个步骤组件静态进入入口 chunk | `src/App.tsx:4`；`src/components/OnboardingDialog.tsx:12-23` | 仅首次启动显示，却每次启动加载 |
| S-04 / P-10 | 顶层 `Suspense` 包住整个 `Routes`：懒加载 chunk 未到时连 Sidebar/Layout 一起被全屏 fallback 替换 | `src/App.tsx:86-112`；`src/components/Layout.tsx:134-145` | 冷启动/首次导航有整壳闪烁 |

### 2.3 LLM/SSE 流式链路

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| S-07 | 每个 token 一次 Channel IPC，多次分配、无批处理/背压 | `src-tauri/src/commands/sse.rs:51-66,78-109,176-201`；`src/services/llm.ts:275-281` | 2000 token≈2000 次事件；React 侧已 50ms 聚合，但 IPC 仍按 token 计 |
| S-08 | `Done` 事件再发送一份完整全文 | `src-tauri/src/commands/sse.rs:196-199,286`；`src/services/llm.ts:260,280-286` | 完成瞬间额外 O(输出长度) 的 IPC/内存峰值 |
| S-09 | 无换行超长 SSE 行会逐 chunk 重扫累积 buffer（最坏 O(n²)） | `src-tauri/src/commands/sse.rs:78-109,218-227` | 仅恶意/异常 provider；32 MB 上限内可长时间耗 CPU |
| S-10 | `testLLMConnection` 的 signal 实际无效、无前端 deadline | `src/services/llm.ts:532-545`；`src/components/onboarding/use-connection-test.ts:32-53`；`src/pages/settings/ModelCard.tsx:164-190` | 失败/离线时“测试中”最长 120s，连点叠加请求 |
| S-11 / H-09 | 阅读提交前串行一次独立 LLM 语言检测，再开始六维分析 | `src/pages/ReadingPage.tsx:214-238`；`src/hooks/use-language-detection.ts:31-41` | 每次提交首 token 时间后移 0.5–3s；可本地启发式预判 |

### 2.4 页面渲染热路径

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| H-01 / H-02 / H-03 / H-04 | Analytics：500+150 窗口主线程解析；时间范围切换重排序/聚合；展开错题导致全部图表重渲；写作聚合未 memo | `src/hooks/use-analytics/*`、`src/pages/AnalyticsPage.tsx` | 详见 `04-pages-hotpaths.md` |
| P-03 | 切换级别会重复解析全部 result（`level` 被放进解析 memo 依赖） | `src/hooks/use-level-estimation.ts:45-48` | 只需重算 `buildSkillEstimates` |
| P-04 | `ResultCard` 折叠即卸载子树：重新展开会重建 Cytoscape 并重跑 COSE 布局、Markdown 全量重解析 | `src/components/ResultCard.tsx:103-106`；`src/pages/ReadingPage.tsx:426-448` | 图谱/长 Markdown 建议 `keepMounted` |
| P-05 / H-08 | 持久化路由壳订阅整个 task-status、PageVisibility value 随导航换新；隐藏页最长保留 10 分钟重型 DOM/Cytoscape | `src/components/PersistentRoutes.tsx:126,140-168,194-205`；`src/contexts/PageVisibilityContext.tsx:29-40` | 导航/任务状态变化会重渲隐藏页 |
| P-06 | 练习页生成阶段 `useLLMStreamPage.result` 每 50ms setState，但页面并不消费 result | `src/hooks/use-practice-session.ts:101-127,161`；`src/hooks/use-llm-stream-page.ts:168,282,334-339` | 约 600 次空转 commit/30s 生成 |
| P-08 | Analytics 局部 UI 状态（展开错题）触发全部 recharts 重渲；LevelProgressCard 派生数据未 memo | `src/pages/AnalyticsPage.tsx:136-139,529-563`；`src/components/analytics/LevelProgressCard.tsx:104-113` | 图表子树无隔离 |
| P-09 / H-12 | Vocabulary 100 张词卡×11 等级按钮 + SpeakButton，搜索/批量进度每项触发整页重渲 | `src/pages/VocabularyPage.tsx:83,373,708-778`；`src/pages/vocabulary/use-batch-runner.ts:62-79` | 1300+ 按钮重渲/按键或每项进度 |
| H-06 | 阅读流式首个 token 就挂载整篇逐词 DOM | `src/pages/ReadingPage.tsx:331-359` | 首次挂载可能 30–150ms 长任务 |
| H-07 | KnowledgeGraph ResizeObserver 每个回调都 `resize()+fit()` | `src/components/knowledge-graph/use-cytoscape-graph.ts:322-340` | 拖拽窗口/全屏过渡时高频 |
| H-15 | Dashboard 每次挂载 7 条查询 + 70 条 result 解析，无短 TTL 缓存 | `src/pages/DashboardPage.tsx:149-172,191-219` | 每次回首页重复 |
| H-16 / H-17 | 历史删除后按“已加载数+20”全量重拉；列表无虚拟化、逐条完整 input_text / 每次格式化日期 | `src/pages/HistoryPage.tsx:121-133,180-222` | 500 条时 50–300ms 级 |
| H-18 | 阅读详情一次渲染全部 Markdown 节 + 无条件拉取/解析 graph_data | `src/pages/HistoryDetailPage.tsx:183-203,217-227` | 20–50 KB Markdown 多节解析 |
| H-21 | CorrectPage 每条纠错两个 SpeakButton，状态更新整页重渲 | `src/pages/CorrectPage.tsx:212-258`；`src/components/SpeakButton.tsx:42-73` | 50 条纠错≈100 个播放器实例 |
| H-22 | ReviewPage 每次评分序列化整个 words 数组写 localStorage | `src/pages/ReviewPage.tsx:86-92,325-330` | 默认 20 词可忽略；500 词恢复场景放大 |

### 2.5 媒体（TTS/ASR）

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| S-13 | 每次 TTS 请求 Rust 侧重读配置 + SSRF 重复 DNS 解析 | `src/services/tts.ts:258-271`；`src-tauri/src/commands/proxy.rs:257-267,660-677`；`src-tauri/src/commands/ssrf.rs:114-134,150-189` | 20 句朗读累计几十至数百 ms |
| S-14 | TTS 音频缓存按 200 条而不是按字节；旧配置版本条目不主动清理 | `src/services/tts.ts:137-153` | 典型常驻 10–40 MB，单条上限 32 MB |
| S-15 / H-19 | 停止录音后在主线程逐样本混音 + WAV 编码 | `src/services/asr.ts:24-85,105-114`；`src/pages/speaking/use-speaking-session.ts:142-161` | 60s 录音约 260 万样本，30–100ms 卡顿 |
| S-16 | ASR 音频以 base64 data URL 跨 IPC（60s≈7.7 MB 字符串，多次拷贝） | `src/services/asr.ts:119-129,147-172`；`src-tauri/src/commands/proxy.rs:567-576,857-898` | 长录音时峰值 20–30 MB |

---

## 3. 分领域详析（重点展开）

### 3.1 首屏包体：一个构建配置问题放大了 424 KB（S-01）

`vite.config.ts:40-63` 用 `codeSplitting.groups` 拆分第三方库。问题链条：

1. `vendor-charts` 的 `test` 只匹配 `node_modules/recharts/`，但 `includeDependenciesRecursively` 默认 `true`（`vite.config.ts:37`），recharts 的依赖 `clsx` 被一并收进该组；
2. `src/lib/utils.ts:1` 的 `cn()` 依赖 `clsx`，`src/components/ui/button.tsx:4` 又依赖 `cn()`；
3. 于是 `button` chunk 生成 `import{v as r}from"./vendor-charts-*.js"`（`dist/assets/button-BzTEq-HL.js:1`），入口 chunk 也静态导入同一 chunk（`dist/assets/index-*.js:2`）；
4. `dist/index.html:10` 因此在**每次冷启动**都 `modulepreload` `vendor-charts-H_zI5iTt.js`（424,550 B raw / 118,209 B gzip），而首页根本不使用 recharts。

首屏 eager JS 合计约 **972 KB raw / 285 KB gzip**（含 CSS），其中未使用的 recharts 占 43.7%。修复建议：把 `clsx`/`tailwind-merge` 拆为更高优先级的小组（`priority: 4`），或对 `vendor-charts`/`vendor-graph` 关闭 `includeDependenciesRecursively`，然后重新构建确认 `dist/index.html` 的 preload 列表不再含 `vendor-charts-*.js`。这是投入最小、收益最直接的一项。

同一类问题还有：首屏共享 chunk 含完整 zod（约 100 KB raw / 30.7 KB gzip，S-02）、`OnboardingDialog` 静态进入口（S-03）。两者可一并做“首屏预算”治理。

### 3.2 数据访问层：大字段与全量列表是主要规模风险（D-01/D-02/D-03）

Rust 侧的基础设施是健康的：WAL、`synchronous=NORMAL`、`busy_timeout=5000`、连接池 5 连接、迁移版本表与 checksum 校验均正确；单类型历史查询、`lower(word)` 唯一索引、`graph_data` 按需读取等都在有效工作（详见 `02-data-backend.md` 的已排除项）。

真正的风险来自**载荷控制**：

- **D-01**：`get_history_list` 的字段列表（`history.rs:75`）包含完整 `input_text`，单条允许 1 MB。Analytics 的 500 条元数据窗口在 500×3 KB 时就是 1.5 MiB，×10 KB 时约 5 MiB；而列表/统计消费方只需要前 60 个字符（`use-recent-sessions.ts:69`）或两行 CSS 截断。建议 SQL 改 `substr(input_text, 1, 200) AS input_text`，详情页单条查询保持完整。
- **D-02**：`get_words(limit=None)` 走无 LIMIT 分支返回整表 19 个字段；`VocabularyPage` 在挂载、清空搜索、每次增删改/补全后都全量重拉，搜索态还会再拉一份全量统计。建议强制分页（默认/上限 500）、单条操作局部更新 state、统计改聚合 SQL（`GROUP BY level, review_status`）。
- **D-03**：CSV 导入逐行 `addWord`，每个词一个 `BEGIN IMMEDIATE` 事务 + 一次 IPC。建议新增 `db_add_words_batch`，单事务批量插入并返回新建/已存在标识，前端按 50–100 条分块以保留进度条。

索引方面，`D-04/D-05/D-06` 的 `EXPLAIN QUERY PLAN` 结论显示：当前数据量下都是毫秒级，但增长趋势是 O(全表/匹配行)，不是 O(LIMIT)。如果产品预期词库/历史会到万级，建议把 `EXPLAIN` 固化为回归测试，并评估 `(created_at DESC, type)` 复合索引、FTS5 或部分索引。

### 3.3 流式链路：渲染已优化，剩余成本在 IPC 与“取消语义”（S-06/S-07/S-08）

这条链路的设计整体是对的：

- React 侧 `TOKEN_FLUSH_INTERVAL_MS = 50`（`use-llm-stream-page.ts:18`），onToken 只追加 ref，50ms 批量 setState，重渲染上限约 20fps；
- Rust 侧按字节切行、跨块 UTF-8 安全、有 32 MB 上限；
- TTS 正式路径返回 `tauri::ipc::Response` 原始字节，不是 base64。

剩余热点：

1. **S-06（P1）**：`proxyStreamChat` 的 `onAbort` 只置 `settled = true` 并 resolve `unavailable`（`services/llm.ts:268-272`）；`invoke` 无法取消 Rust 命令（同文件 `:246-248` 注释明确）。Rust 的 `pump_sse_stream` 只有 `on_event.send` 返回 Err 才停止（`sse.rs:188-193`），而 Channel 仍有效，所以旧请求会继续读到上游结束或 120s 超时（`proxy.rs:287-333`）。对远程 LLM 是额外 token 计费，对本地 Ollama 是额外 CPU。建议 Rust 侧增加 request-id→CancellationToken 注册表与 `cancel_stream` 命令，前端 abort 时调用；短期至少为重提交场景传更短 timeout。
2. **S-07（P2）**：每个 token 一次 `ProxyEvent::Token` Channel 消息，且经过 `to_vec`→`String::from_utf8`→`to_string`→`serde_json::Value`→`token.to_string()` 多次分配。建议 Rust 侧按 16–32ms 或网络 chunk 合并成 `TokenBatch`，并用 typed struct 替代 `Value`。
3. **S-08（P2）**：`Done` 事件再携带一份完整 `full_text`（`sse.rs:196-199`），前端也自行累积；长输出完成瞬间产生额外 IPC/内存峰值。建议 Done 不带全文，或只在未收到任何 token 时携带。

### 3.4 页面渲染：最重的是 ReadingPage 的逐词 DOM（H-05/P-01）与长文流式预览（H-20）

ReadingPage 的 `OriginalText`（`ReadingPage.tsx:99-133`）为了“点击单词查词/加入生词本”，把每个空白 token 渲染成一个 `<button>`。`memo` 本身存在，但 `currentSentenceIndex` 是 prop，朗读每切一句都会让整篇组件重渲染，并在 render 内对每一句重新 `sentence.split(/(\s+)/)`。2000 词文章约 3000–4000 个按钮，每句切换全量 reconcile；5000 词文章更明显。建议：

- 拆 `SentenceRow = memo(...)`，只让当前句及其相邻句重渲染；
- 每句 token 数组 `useMemo` 预计算，避免 render 期 split；
- 高亮改为容器 CSS class/`data-active`，或容器级事件委托替代每个词一个 button。

另外 `{result && ...}` 让原文区在流式首个 token flush（约 50ms）就挂载整篇词表（`ReadingPage.tsx:331-359`），长文一次 30–150ms 长任务；建议 `!loading` 后再挂载交互层，流式期间显示纯文本预览。

CorrectPage 的 `StreamPreview`（`CorrectPage.tsx:51-57`）直接渲染完整累积 JSON，没有 ReadingPage 的尾部截断保护（`ReadingPage.tsx:57-68` 只渲染末尾 2000 字符）。修复成本极低：复用同样的 tail 截断即可。

### 3.5 启动与设置页：固定成本被做了多次（S-05/D-07/P-02）

冷启动约 14 次 `invoke`：App onboarding 检查 2 次、通知链 3–4 次串行、GoalsProvider 1 次、Sidebar 聚合 1 次（内部 4 个查询）、Dashboard 7 次（其中 3 个 `getHistoryWithResults` 各 2 次内部查询）。重复项：review stats 在通知/Sidebar/Dashboard 各算一次全表统计；streak 读两次；goals 读两次。建议用一个启动期共享快照（或短 TTL 缓存）把 review stats/streak/goals 复用，通知链合并为单个 Rust 命令。

设置页的 `LevelCard` 通过 `useLevelEstimation` → `useHistoryWindow` 拉 500 条元数据 + 150 条 result，而它只显示 5 个技能徽章与少量建议（`LevelCard.tsx:31-32`）。建议给被动估级单独的小窗口（如 100/50）或加短 TTL 缓存；同时把 `level` 从解析 memo 的依赖中拆出（P-03），避免切换级别时重复 JSON.parse + Zod。

### 3.6 TTS/ASR：串行与主线程编码是体验瓶颈（S-12/S-15/S-16）

- **S-12（P1）**：`useReadAloud` 的 `for` 循环 `await play(sentences[i])`，`playAudio` 在 `audio.onended` 才 resolve（`tts.ts:227-230`），因此下一句的合成请求必须等前一句播完。20 句文章按每句 0.5–1.5s 合成估算，累计多出 10–30s 空白。建议新增 `prefetchTTS()`（复用 `audioUrlCache`），播放第 i 句时预取 i+1。
- **S-15（P2）**：`mixDownToMono` + `audioBufferToWav` 在主线程逐样本循环；60s 录音约 260–290 万样本，30–100ms 卡顿。建议移到 Worker 或 Rust，至少改索引循环。
- **S-16（P2）**：ASR 以 base64 data URL 跨 IPC，60s 录音约 7.7 MB 字符串、多次拷贝。建议改二进制 IPC 或临时文件路径。

---

## 4. 建议修复路线（按投入产出排序）

### 阶段一：快速见效（1–2 天，改动局部、可独立验证）

1. **S-01**：`vite.config.ts` 给 `clsx`/`tailwind-merge` 单独分组或关闭 charts 组递归；重新 build 验证 `dist/index.html` 不再 preload `vendor-charts-*.js`。
2. **D-01**：`get_history_list` 用 `substr(input_text, 1, 200)`；详情页 `get_history_by_id` 不变。
3. **H-20/P-07**：CorrectPage 复用 `STREAM_PREVIEW_TAIL_CHARS` 尾部截断。
4. **H-05/P-01（第一步）**：`OriginalText` 按句拆 memo、token 数组预计算；先不动交互结构。
5. **S-12**：TTS 预取下一句（服务层加 `prefetchTTS`，`useReadAloud` 在 i 播放时预取 i+1）。
6. **P-02/P-03**：LevelCard 用小窗口或短 TTL 缓存；拆开 level 与解析 memo。

### 阶段二：结构性改造（1–2 周）

1. **D-02**：`db_get_words` 强制分页 + 统计聚合命令；单条操作局部更新。
2. **D-03/H-10**：新增 `db_add_words_batch`（单事务）+ 批量补全并发池（2–4，受控 rate limit）。
3. **S-06**：Rust 侧 request-id 取消注册表 + `cancel_stream` 命令；前端 abort 时调用。
4. **S-07/S-08**：Rust 侧 token 批处理 + Done 不带全文。
5. **启动共享快照**：review stats/streak/goals 单次加载，通知链合并命令（S-05/D-07）。
6. **ReadingPage 逐词 DOM**：容器事件委托 + 虚拟化/折叠（长文场景）。
7. **Analytics/History 列表**：图表/列表 memo 与 state 下沉、分页窗口/虚拟化（P-08/H-16/H-17）。

### 阶段三：建立性能基线（持续）

1. 在 `src-tauri` 加 `EXPLAIN QUERY PLAN` 回归测试（重点 D-04/D-05/D-06），每次新增迁移/索引后运行。
2. 用 React Profiler / Chrome Performance 建立场景矩阵：长文流式（2k/5k 词）、朗读切句、词库 5k/10k、历史 20k、设置页首次打开、冷启动首帧。
3. 给关键路径加 `performance.mark/measure` 或 `tracing::debug_span!`（`get_history_list`、`get_words`、`get_review_stats`、`get_sidebar_data`、`pump_sse_stream`），区分 SQL / IPC / 渲染成本。
4. 首屏包体加预算检查（构建后检查 `dist/index.html` preload 列表与总 raw bytes）。

---

## 5. 已排除的“疑似瓶颈”（已核实不成立或已优化）

这些点看起来像热点，但代码证据表明当前实现是正确的，避免误排期：

1. **流式 token 每 token 一次 React setState**：不成立。`onToken` 只追加 ref 缓冲，50ms 批量 `setResult`（`use-llm-stream-page.ts:18,260-287,332-343`）。
2. **ReadingPage 流式期间重新 `parseSections` / 全量 Markdown**：不成立。`loading` 时 `sections` 返回 `EMPTY_SECTIONS`，只渲染末尾 2000 字符预览（`ReadingPage.tsx:57-84,277-280,399`）；完整解析在流结束后一次完成。
3. **KnowledgeGraph 因父组件重渲染而重建 Cytoscape**：不成立。实例 effect 只依赖 `[data]`（`use-cytoscape-graph.ts:161-291`），语言切换就地更新标签、主题只 `style().update()`，事件监听器均清理。
4. **折叠的 ResultCard 提前创建 Markdown/Cytoscape**：不成立。`{expanded && <CardContent>}` 条件渲染（`ResultCard.tsx:103-106`），折叠时不产生子树（但重新展开会重建，见 P-04 的反面）。
5. **Analytics 切换时间范围重复 JSON.parse**：不成立。`parsedAll` 只依赖 `[allRecords, resultById]`（`use-analytics/index.ts:177-180`），`days` 变化只过滤数组（但仍有排序/聚合成本，见 H-02）。
6. **每次请求新建 reqwest Client / 每次读 Keychain**：不成立。Client 在 `lib.rs:133-154` 创建一次并 `State` 复用；Keychain 有 5 分钟进程内读缓存（`credentials.rs:28-39,121-139`）。
7. **TTS 音频 base64 跨 IPC 很大**：不成立（正式路径）。`fetch_tts_audio` 返回 `tauri::ipc::Response::new(audio)` 原始字节（`proxy.rs:660-693`）；base64 只在 ASR **输入**路径（S-16）。
8. **AudioContext / blob URL 泄漏**：不成立。`convertToWav` 在 finally 关闭 AudioContext（`asr.ts:105-114`）；TTS 缓存 `onEvict` 调 `URL.revokeObjectURL`（`tts.ts:137-153`）。
9. **启动迁移每次做重活**：不成立。已应用迁移只读 14 行版本 + checksum，`migrate_api_key_column` 用 `PRAGMA table_info` 短路（`db.rs:152-322`）；全表重建只发生在一次性升级迁移。
10. **PersistentRoutes 启动就挂载 CorrectPage/ReadingPage**：不成立。只在首次访问对应路径时加入 `mounted`，且 lazy 加载（`PersistentRoutes.tsx:25-26,116-209`）。
11. **Context value 未 memo 导致全树重渲**：不成立。`GoalsContext` 的 value 经 `useMemo` 且有内容相等守卫（`GoalsContext.tsx:43-71`）；ThemeProvider 同样 memo。
12. **列表 key 缺失、effect 循环、定时器/监听器泄漏**：未发现。组件 key 均有业务键或显式说明；定时器/监听器均有 cleanup（详见 `01-frontend-rendering.md` 的已排除项）。

**结论**：现有代码的性能基础设施是健康的；真正需要排期的是第 1 节的 10 项 P1 与第 2 节中规模化后影响明显的 P2。

---

## 6. 建议的测量方法（验证优先级）

1. **首屏包体**：`npx vite build` 后检查 `dist/index.html` 的 `modulepreload` 列表与 `dist/assets` 总 raw bytes；DevTools Performance 录制“冷启动 → 首帧 Dashboard”，看 Scripting/Compile 与 Sidebar 首现时间。修复 S-01 前后对比。
2. **历史/词库载荷**：用真实 `raven.db` 副本，在 `get_history_list`/`get_words` 返回前统计 `serde_json::to_vec(&dto).len()`；DevTools Performance 观察 invoke resolve 后主线程反序列化耗时。构造 500 条×1/3/10 KB、5k/10k 词两档。
3. **流式与取消**：在 `channel.onmessage` 统计 token 事件数、总字符数、首 token 时间；abort 后观察 Rust 是否继续发送事件；在 `pump_sse_stream` 加 `tracing::debug_span!` 统计 chunk/line/send 次数。
4. **页面渲染**：React Profiler 录制 2k/5k 词文章流式、朗读切句、CorrectPage 长文；Chrome Performance 的 long task（>50ms）与 `document.querySelectorAll('button').length`。
5. **TTS/ASR**：在 `use-read-aloud` 循环中打点拆分“合成耗时/播放耗时”，对比预取前后句间 gap；`performance.now()` 包住 `convertToWav`/`blobToDataUrl`/`transcribeAudio`，分别测 5/15/60s 录音。
6. **SQL 计划**：对 `get_history_list`（单类型/多类型/无过滤）、`get_history_results_by_type`、`get_words`（搜索/非搜索）、`get_review_words`、`get_review_stats` 执行 `EXPLAIN QUERY PLAN`，断言是否出现 `USE TEMP B-TREE FOR ORDER BY` 与索引名；建议做成 Rust 集成测试/基准。

---

## 7. 附：发现统计与报告边界

| 分报告 | P0 | P1 | P2 | Info | 主要独有发现 |
| --- | ---: | ---: | ---: | ---: | --- |
| 01 前端渲染/hooks | 0 | 2 | 8 | 6 | ReadingPage 逐词 DOM、LevelCard 窗口、PersistentRoutes/Suspense |
| 02 数据/Rust/SQLite | 0 | 3 | 6 | 2 | input_text 窗口、词库全量、CSV 批量事务、EXPLAIN 计划 |
| 03 流式/启动/包体 | 0 | 4 | 13 | 1 | vendor-charts 首屏、abort 不取消、TTS 逐句串行、ASR base64 |
| 04 页面热路径 | 0 | 4 | 18 | 11 | ReadingPage 长文、批量串行、CorrectPage 流式预览、Dashboard/History |

> 注：跨报告重复项（如 H-05/P-01、H-10/H-11/S-17、H-20/P-07、H-09/S-11、H-19/S-15）在汇总时已合并；各分报告保留独立编号以便追溯。P2 总数因去重口径不同略有差异，以各分报告明细为准。

---

*本报告基于 2026-10-31 工作副本的静态代码审查与仓库内 `dist/` 构建产物；所有耗时/内存数字除明确标注“实测”外均为静态估算，建议按第 6 节在目标机器与真实数据库上复核后再排期。*
