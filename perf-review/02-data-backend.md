# 性能审查 B：数据访问层与 Rust/SQLite 后端

> 审查对象：Raven `D:\GitHub\raven`（Tauri v2 + React 19 + TypeScript + Rust/rusqlite）
> 审查范围：`src/lib/db/**`、`src-tauri/src/db.rs`、`src-tauri/src/repository/**`、`src-tauri/src/commands/{history,words,learning,models,settings,export}.rs`、`src-tauri/migrations/**`
> 审查方式：只读代码分析。全部结论均回读源码核实；索引结论结合 `src-tauri/migrations/**` 的实际 DDL 判断，并用本机 Python `sqlite3 3.53.1` 基于项目真实迁移建内存库做了 `EXPLAIN QUERY PLAN` 与数据量/载荷量级实验（不修改源码、不运行 cargo/npm 构建）。
> 说明：Python 自带 SQLite 版本高于 Tauri packaged 的 rusqlite（`db.rs:359` 注释为 3.35+ 能力，项目实际 bundled 3.44+），查询计划形状可能有版本差异；凡是计划结论都可在真实库上用同样 SQL 复核。

---

## 摘要

- 本轮数据访问层未发现达到 **P0** 的问题：SQLite 连接配置（WAL / `synchronous=NORMAL` / `busy_timeout`）、单类型历史查询索引、`add_word` 表达式唯一索引、迁移版本跟踪等基础设计基本正确。
- 共发现 **3 个 P1**：历史列表窗口携带完整 `input_text`、生词本全量加载/全量刷新、CSV 批量导入逐词 IPC + 逐事务写入。三者都属于"特定数据量/长文本场景可感知"，在常规小数据量下不明显，但随用户积累会线性恶化。
- 共发现 **6 个 P2**（多类型历史查询临时排序、词库模糊搜索全表扫描、复习队列扫描排序、Sidebar/Dashboard/通知重复查询、导出双份 IPC、结果窗口只限条数不限字节）。
- **2 个 Info**（未被任何查询使用的 `idx_words_level`、TTS 配置拆两次查询）。
- 已排除的疑似项：见文末"已排除项"；其中"迁移每次启动做重活"不成立——已应用迁移只做版本/checksum 读取，`migrate_api_key_column` 用 `PRAGMA table_info` 短路，均为微秒级。

| 编号 | 严重级 | 标题 | 位置 |
| --- | --- | --- | --- |
| D-01 | P1 | 历史列表窗口携带完整 `input_text`（500 条） | `src-tauri/src/repository/history.rs:75` |
| D-02 | P1 | 生词本全量加载 + 每次增删改全量刷新 | `src-tauri/src/repository/words.rs:100-120` |
| D-03 | P1 | CSV 批量导入逐词 IPC + 逐事务写入 | `src/pages/vocabulary/use-vocabulary-import.ts:102-159` |
| D-04 | P2 | 历史多类型 `IN` 查询走临时 B-Tree 排序 | `src-tauri/src/repository/history.rs:123-141` |
| D-05 | P2 | 词库模糊搜索 `%kw%` 全表扫描 | `src-tauri/src/repository/words.rs:99-118` |
| D-06 | P2 | 复习队列/统计全表扫描并排序 | `src-tauri/src/repository/words.rs:189,214` |
| D-07 | P2 | Sidebar/Dashboard/通知重复查询同一聚合数据 | `src/components/Sidebar.tsx:93` 等 |
| D-08 | P2 | 导出全量 CSV 两次跨 IPC（Rust→WebView→Rust） | `src/lib/db/export.ts:8-10` |
| D-09 | P2（疑似） | 结果窗口只限条数、不限总字节，极端数据内存风险 | `src-tauri/src/repository/history.rs:36` |
| D-10 | Info | `idx_words_level` 索引无人使用 | `src-tauri/migrations/001_init.sql:55` |
| D-11 | Info | TTS 配置读取拆成两次查询 | `src-tauri/src/repository/settings.rs:69-70` |

---

## 发现列表

### D-01（P1）历史列表窗口携带完整 `input_text`，500 条窗口在 Analytics/设置页每次全量跨 IPC

**位置**
- `src-tauri/src/repository/history.rs:75`：`get_history_list` 的字段列表为 `id, type, input_text, '' AS result, NULL AS graph_data, difficulty_level, created_at`——`input_text` 是**整列原文**，不是预览。
- `src-tauri/src/repository/history.rs:96`：`query_history` 的字段白名单同样只允许这个包含完整 `input_text` 的组合。
- `src/lib/db/history.ts:129-130`：`HISTORY_RECORD_LIMIT = 500`、`HISTORY_RESULT_LIMIT = 150`；`getHistoryWithResults` 在 `src/lib/db/history.ts:184-191` 用 500 条窗口调用 `getHistoryList`。
- 消费方：`src/hooks/use-history-window.ts:75-80`（Analytics 编排层与设置页 `LevelCard` 的被动估级共用）；`src/hooks/use-analytics/use-recent-sessions.ts:69` 只用 `r.input_text.slice(0, 60)`；`src/pages/HistoryPage.tsx:216-217` 用 `line-clamp-2` 只显示两行。
- 单条上限：`src-tauri/src/repository/history.rs:35-42` 允许 `input_text` 最大 1,000,000 字节。

**机制与影响**
列表查询把每条记录的完整原文（阅读页用户粘贴的整篇文章）读入 `HistoryDto`，经 serde 序列化成 JSON 跨 Tauri IPC，再在 WebView 主线程反序列化。Analytics 页和设置页 `LevelCard`（`src/pages/settings/LevelCard.tsx:31-32` → `useLevelEstimation` → `useHistoryWindow`）每次挂载都会走 500 条窗口，其中绝大部分文本无人消费；随后结果窗口又传 150 条 `result`。这是"已经优化了 `result`/`graph_data`，但漏掉了同属重型列的 `input_text`"的典型残留。

**量级估算**（用代表性 `HistoryDto` JSON 实测，UTF-8）
- 500 条 × 平均 1 KB 原文 ≈ **0.57 MiB**
- 500 条 × 平均 3 KB 原文 ≈ **1.54 MiB**
- 500 条 × 平均 10 KB 原文 ≈ **4.95 MiB**
- 理论上限（500 × 1 MB）为 500 MB 级别，长文章用户可轻易进入 MB 级。

**建议**
1. 列表查询改为 `substr(input_text, 1, 200) AS input_text`（HistoryPage 两行预览、Analytics 60 字符预览均够用），同时更新 `ALLOWED_FIELDS` 白名单；详情页 `get_history_by_id`（`src-tauri/src/repository/history.rs:168`）继续返回完整原文，不受影响。
2. 或让 `get_history_list` 不返回 `input_text`，列表预览改为新字段 `input_preview`；从协议上避免任何列表路径携带重型列。
3. 若短期不改 SQL，至少让 Analytics/`useHistoryWindow` 使用独立命令，不请求 `input_text`。

**状态**：已确认（代码路径与实际 JSON 载荷量级均核实）；具体用户感知取决于其阅读文章长度与记录数。

---

### D-02（P1）生词本全量加载，且每次增删改后全量刷新；搜索态还会再拉一份全量统计快照

**位置**
- `src-tauri/src/repository/words.rs:93-122`：`get_words` 的 `limit: Option<i64>` 为 `None` 时走 `None` 分支（`words.rs:113-119`），**没有任何上限**，直接返回整表并序列化 19 个字段（含 7 个 FSRS 字段，`src/dto.rs:162-183`）。
- `src/lib/db/words.ts:38-45`：前端注释明确"不传返回全部"。
- `src/pages/VocabularyPage.tsx:107-112`：注释确认挂载与清空搜索时主列表就是全量加载。
- `src/pages/VocabularyPage.tsx:162`：`loadWords` 调 `getWords(undefined, undefined, keyword)`；搜索为空时即全量，**搜索非空时也因 `limit=undefined` 走 Rust 的 `None` 分支——匹配结果同样没有 LIMIT 上限**（`words.rs:113-119`）。
- `src/pages/VocabularyPage.tsx:189`：搜索态 `refreshStats()` 再调 `getWords()` 拉一份全量做分级统计。
- `src/pages/VocabularyPage.tsx:205-208`：`refresh()` 在删除、改等级、单条补全、添加后均调用 `loadWords`——即**每改一个单词都重新拉整表**。
- `src/pages/vocabulary/use-vocabulary-import.ts:93`：CSV 导入前再额外 `getWords()` 全量建去重基线。

**机制与影响**
词汇页把"数据获取"和"统计"都绑在一次全表查询上：挂载、搜索清空、任意单条修改都会把全部单词（含音标、释义、例句、笔记、FSRS 状态）通过 IPC 拉一遍。用户词库达到数千词后，每次删除/标记等级/补全都会看到明显延迟和主线程 JSON 解析开销；搜索态下一次刷新会并发/顺序触发两次全表读（主列表 + 统计快照）。

**量级估算**（代表性 `WordDto` JSON 实测）
- 5,000 词 ≈ **2.16 MiB**
- 10,000 词 ≈ **4.32 MiB**
- 搜索态 `refresh()`：同一时刻 **2 × 全表** 读取与解析。

**建议**
1. `db_get_words` 强制分页（默认/上限 500），列表按 `limit/offset` 分页；页面已有 `RENDER_PAGE_SIZE = 100`（`VocabularyPage.tsx:83`）的增量渲染，可改为"渲染 += 100"时再请求下一页。
2. 分级统计单独提供聚合命令：`SELECT level, review_status, COUNT(*) FROM words GROUP BY level, review_status`，不要把全量 WordDto 当统计数据源。
3. 单条增删改后用返回值局部更新 state，或只重取当前页；删除/入库接口可返回影响行。
4. CSV 导入去重可依赖 `add_word` 的 `lower(word)` 唯一索引 + "是否新插入"返回值，去掉导入前全量基线（见 D-03）。

**状态**：已确认（代码注释本身承认全量取舍）；是否可接受取决于产品对"词库上限"的预期，超过约 5k 词后收益明显。

---

### D-03（P1）CSV 批量导入逐词 `invoke` + 每条一个 `BEGIN IMMEDIATE` 事务，N 条数据 N 次 IPC/N 次提交

**位置**
- `src/pages/vocabulary/use-vocabulary-import.ts:102-159`：`run(dataLines, { processItem })` 内对每一行 `await addWord(...)`（`:123`），无批量接口。
- `src/pages/vocabulary/batch-processor.ts:47-68`：`runBatch` 是严格 `for` 循环 + `await processItem(item)`，**串行**。
- `src-tauri/src/repository/words.rs:34`：`add_word` 每次调用都 `with_immediate_tx`（`BEGIN IMMEDIATE` → `SELECT lower(word)` → `INSERT` → `COMMIT`），`repository/mod.rs:32-55` 为事务实现。
- `src-tauri/src/commands/words.rs:30-34`：只有单条 `db_add_word` 命令，没有批量写命令。
- `src/pages/vocabulary/use-vocabulary-import.ts:161-162`：导入结束后 `refresh()` 再触发一次全表 `getWords()`（见 D-02）。

**机制与影响**
导入 1,000 个单词 = **1,000 次 IPC 往返 + 1,000 个独立写事务**（每个事务都要取写锁、维护 WAL 帧、提交），再加导入前后各一次全表读。每个事务都持写锁，还会与并发写入（如学习打卡 `db_record_learning_activity`）互相排队。当前实现选择逐条是为了进度条和失败计数，但代价与用户导入规模线性增长；1000 词级别导入会出现秒级等待（IPC 往返占主导，SQLite 提交本身也有 ~10× 放大）。

**量级估算**（SQLite 磁盘 WAL 探针：Python `sqlite3`、`PRAGMA journal_mode=WAL; synchronous=NORMAL`）
- 200 条逐事务写入：**6.1 ms**；200 条单事务写入：**0.5 ms**（仅 DB 侧约 12×，尚未计入 200 次 IPC 与 JS await 调度）。
- 1,000 条：DB 侧约 30 ms + 1,000 次 Tauri invoke（通常每次 1–5 ms 量级）≈ **1–5 秒**；若导入文件无释义还会逐词调 LLM（网络耗时另行叠加）。

**建议**
1. 新增 `db_add_words_batch(entries: Vec<NewWordInput>) -> { ids, existingIds, failed }`：在**一个事务**内完成校验、`lower(word)` 去重、批量 INSERT；导出进度可按 50–100 条分块调用（保持进度条）。
2. 前端导入改为按块调用批量命令；逐词 LLM 补全仍可保留（网络是主要成本），但补全写回可同样批量 `db_update_word_enrichment_batch`。
3. 批量命令返回"新建/已存在"标识，替代 `use-vocabulary-import.ts:93` 的全量去重基线。
4. 批量补全（`src/pages/vocabulary/use-batch-enrich.ts:54-66`）虽是 LLM 主导，也建议把 `updateWordEnrichment` 合并为批量写，减少无谓 IPC。

**状态**：已确认（调用链与事务结构均核实；具体秒数依赖机器与 IPC 延迟）。

---

### D-04（P2）历史多类型 `IN` 查询使用 `idx_history_type_date` 后仍需 `TEMP B-TREE` 排序；单类型查询无此开销

**位置**
- `src-tauri/src/repository/history.rs:123-141`：`record_types.len() > 1` 时拼 `WHERE type IN (...)` + `ORDER BY created_at DESC LIMIT/OFFSET`。
- `src-tauri/src/repository/history.rs:253-285`：`get_history_results_by_type` 同样是 `type IN (...)` + `ORDER BY created_at DESC LIMIT`。
- `src-tauri/migrations/008_add_indexes.sql:20`：已有 `idx_history_type_date(type, created_at DESC)`；`src-tauri/migrations/010_repair_srs_backfill_and_index.sql:24` 另有 `idx_history_created(created_at DESC)`。

**机制与证据**
在按真实迁移建库、插入 20,000 条 history 后实测：
- 单类型：`SEARCH history USING INDEX idx_history_type_date (type=?)`，**无临时排序**（索引内的 `created_at DESC` 直接满足 ORDER BY）。
- 多类型 `IN (6 个类型)` + `LIMIT 500`：`SEARCH history USING INDEX idx_history_type_date (type=?)` + **`USE TEMP B-TREE FOR ORDER BY`**——SQLite 按每个 `type` 分别走索引后必须合并排序，代价随命中行数增长，而不是随 LIMIT 增长。
- 同查询强制 `INDEXED BY idx_history_created` 后：`SCAN history USING INDEX idx_history_created`，20k 行实测 **0.5 ms vs 2.4 ms**（约 5×；绝对量当前很小，但增长趋势是 O(全部匹配行) 而非 O(500)）。

**受影响路径**
- Analytics 元数据窗口：6 类 × 500 条（`use-history-window.ts:75-80`）。
- Analytics result 窗口：5 类 × 150 条（`getHistoryResultsByType`）。
- Dashboard 写作窗口：`["correct","writing"] × 20`（`DashboardPage.tsx:163`）。
- HistoryPage "Writing" 筛选：`correct+writing` × 20/页（`HistoryPage.tsx:67-89`）。
- `get_recent_correct_results`：`correct+writing` × 20（`history.rs:296`）。

**建议**
1. 在 `query_history` 中识别"类型集合覆盖全部合法类型"时走无过滤分支（利用 `idx_history_created`），避免 Analytics 的 6 类查询退化为全表排序。
2. 对多类型固定场景（2 类）可改写成 `UNION ALL` 各类型子查询带自身 `LIMIT` 后外层合并；或在 SQLite 计划层面验证 `INDEXED BY idx_history_created` 的收益。
3. 新增覆盖 `(created_at DESC, type)` 的复合索引可同时服务"按时间取窗口 + 类型过滤"，但需评估写入成本（history 为低频写表，可接受）。
4. 将 `EXPLAIN QUERY PLAN` 固化为仓库级回归测试（本仓库 008 迁移注释里的 O4 校验没有对应测试）。

**状态**：已确认（SQLite 计划实测）；生产影响为"疑似/低"，因当前 20k 行下仅毫秒级，需用真实历史表规模复核。

---

### D-05（P2）词库模糊搜索 `%kw%` 对 3 列做 `lower() LIKE`，无法使用任何 B-Tree 索引，全表扫描

**位置**
- `src-tauri/src/repository/words.rs:99`：搜索词被包成 `%{}%`。
- `src-tauri/src/repository/words.rs:105` / `:115`：`lower(word) LIKE ?1 OR lower(definition) LIKE ?1 OR lower(COALESCE(phonetic,'')) LIKE ?1`。
- `src-tauri/migrations/013_words_unique_lower.sql:22`：已有 `idx_words_word_lower ON words(lower(word))`，但只支持等值查询；前置通配符 `%...` 使 B-Tree 无法定位。
- 搜索触发：`src/pages/VocabularyPage.tsx:216-228`（300ms 防抖）；添加单词预检 `src/pages/vocabulary/use-add-word.ts:58` 与 `src/hooks/use-add-to-vocabulary.ts:115` 也走同一条 SQL（`PRECHECK_CANDIDATE_LIMIT = 500`）。
- `src-tauri/src/repository/words.rs:113-119`：词汇页搜索调用 `getWords(undefined, undefined, keyword)`，`limit=None` 走无 LIMIT 分支，命中多时会把所有匹配行（19 字段 DTO）全部传回。

**机制与证据**
`EXPLAIN QUERY PLAN` 实测（2,000 词库）：`SCAN words USING INDEX idx_words_created_at`——索引仅用于满足 `ORDER BY created_at DESC`，每行仍需执行最多 3 次 `lower()` + `LIKE`。搜索匹配率越低，扫描越接近全表；预检路径还会把最多 500 条完整 `WordDto` 序列化回前端（只为比较 `word` 字段）。

**量级估算**
- 5,000–10,000 词库：每次搜索需对全表每行做 3 次 `lower()` 与 `LIKE`，预计数毫秒到数十毫秒（取决于机器与匹配分布）；用户每 300ms 输入停顿触发一次，连续输入会多次扫描。
- 添加单词预检：每次添加（含从阅读页收藏）至少一次 500 条候选的全字段 DTO 读取。

**建议**
1. 最小改动：预检增加专用轻量命令 `db_word_exists(word)`（`SELECT 1 FROM words WHERE lower(word)=lower(?1)`，可走唯一索引），不返回 DTO 列表。
2. 搜索改为前缀匹配 `kw%`（可利用 `idx_words_word_lower`）并单独提供"全文包含"高级搜索；或引入 SQLite FTS5 虚拟表（word/definition/phonetic），用 `MATCH` 替代 `LIKE '%...%'`。
3. 若维持 `%kw%`，至少在 Rust 侧对 `%`、`_` 做转义并明确这是 O(n) 搜索。

**状态**：已确认全表扫描（EXPLAIN）；实际单次耗时与词库规模相关，未在本机做 10k 词的 UI 端到端测量。

---

### D-06（P2）复习队列与复习统计都对 `words` 全表扫描，复习队列还额外临时排序

**位置**
- `src-tauri/src/repository/words.rs:211-220`：`get_review_words` 的 `WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status='new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1`。
- `src-tauri/src/repository/words.rs:184-202`：`get_review_stats` 的 5 个聚合（`COUNT(*)` + 4 个 `SUM(CASE...)`）。
- 索引：`src-tauri/migrations/008_add_indexes.sql:16` `idx_words_review(review_status, next_review_at)`。

**机制与证据**
`EXPLAIN QUERY PLAN` 实测：
- `get_review_words`：`SCAN words USING COVERING INDEX idx_words_review` + **`USE TEMP B-TREE FOR ORDER BY`**。原因是 `review_status != 'mastered'` 是否定条件（无法等值定位），且 `ORDER BY CASE WHEN ...` 是表达式排序，无法利用 `(review_status, next_review_at)` 的列序。
- `get_review_stats`：`SCAN words USING COVERING INDEX idx_words_review`（单次全表覆盖扫描，本身已避免回表）。

**影响**
每次 Sidebar 导航（`Sidebar.tsx:87-117`，2s 节流）都会执行 `get_review_stats` 全表扫描；ReviewPage 进入时执行 `get_review_words` 全表扫描 + 排序。词量在几千级时是亚毫秒到毫秒级，属于可接受范围；但词库长期增长（如 5 万词）或低端机上会进入可感知区间。

**建议**
1. 建部分索引：`CREATE INDEX idx_words_due ON words(next_review_at) WHERE review_status != 'mastered'`，让复习队列至少只扫未掌握子集；排序仍可用 `UNION ALL new/learning + ORDER BY next_review_at` 消除 CASE。
2. `get_review_stats` 若成为热点，可增加轻量汇总表或按 `review_status` 分组查询再在应用层求和（仍一次扫描）。
3. 与 D-07 合并：Sidebar 和 Dashboard 共用同一份 review 统计结果，避免重复扫描。

**状态**：已确认（计划实测）；实际延迟待真实词库测量。

---

### D-07（P2）Sidebar / Dashboard / 通知启动路径重复查询同一聚合数据（review stats、streak、goals）

**位置**
- `src/components/Sidebar.tsx:87-117`：每次导航调用 `getSidebarData()`。
- `src/pages/DashboardPage.tsx:158-159`：Dashboard 挂载同时调用 `getReviewStats()` 与 `getLearningStreak()`。
- `src/services/notifications.ts:31-44`：应用启动 `checkAndNotifyReview()` 内又调用 `getReviewStats()`。
- `src-tauri/src/repository/learning.rs:152-176`：`get_sidebar_data` 依次执行 `get_review_stats`（全表扫描）、`get_all_streaks`（`learning.rs:43-56`，最多 365 行完整 JSON）、`get_learning_goals`、`get_today_activities` 共 4 个查询。
- `src/contexts/GoalsContext.tsx:66-68`：`GoalsProvider` 挂载又调用 `getLearningGoals()`，与 `getSidebarData` 返回的 goals 重复。

**机制与影响**
冷启动/首屏（`Dashboard` 为默认路由）时：
- `review_stats` 全表 `words` 扫描会被执行 **2–3 次**（Sidebar、Dashboard、Notification）；
- 365 天的 `learning_streaks` 数据被读取 **2 次**（Sidebar 聚合 + Dashboard 的 `getLearningStreak`，`learning.ts:57-61`）；
- `learning_goals` 被查询 **2 次**（`getSidebarData` + `GoalsProvider`）。

绝对量都小（词表数千行、streak 365 行），但这是每次窗口重启 + 每次 Dashboard 挂载都会发生的固定开销，且 `get_all_streaks` 为了算一个整数把 365 天的 `activities` JSON 全带回来。

**建议**
1. 让 `Sidebar` 的数据进入共享 store（或把 review stats/streak 一并放进现有 GoalsContext 风格的聚合 provider），Dashboard 直接消费，不再重复查询。
2. 通知服务复用启动时已取得的 review 统计（或在 Rust 侧提供 `db_get_due_count` 只读极小查询）。
3. `get_sidebar_data` 内 `learning_streaks` 改为 SQL 侧计算连续天数（例如递归 CTE 或按日期序列在 Rust 内只取 `date` 列），至少避免传输 365 条 `activities` JSON。
4. `GetSidebarDataDto` 的 `goals` 字段若 Sidebar 不再使用可删除，减少一次查询与协议冗余。

**状态**：已确认（调用点与查询结构核实）；优化收益为固定小常数，排序 P2。

---

### D-08（P2）导出全量 CSV 跨两次 IPC：Rust → WebView 字符串，再由 WebView → Rust 写文件

**位置**
- `src/lib/db/export.ts:8-10`：`exportWordsCsv()` 返回 `Promise<string>`（整份 CSV 经 IPC 进入 WebView）。
- `src/pages/VocabularyPage.tsx:338-347`：拿到的 `content` 字符串再作为参数传给 `writeTextFileDialog`。
- `src-tauri/src/commands/export.rs:111-137`：`write_text_file_dialog(default_file_name, extension, content: String)` 在 Rust 侧再接收整份内容并 `std::fs::write`。
- `src-tauri/src/repository/export.rs:16-74`：CSV 查询与拼接在 Rust 完成；`:77-105` 为 Anki 版本。

**机制与影响**
导出一次 CSV，完整文件内容要经历两遍 IPC 序列化/反序列化（Rust String → JSON → JS String → JSON → Rust String），且同一份数据同时存在于 Rust 和 WebView 内存。对 5,000–10,000 词的词库，文件约 1–3 MB（带释义/音标/笔记），双份传输与 JSON 转义会带来几十毫秒级开销与内存峰值；虽然是一次性用户操作，但属于无谓损耗。

**建议**
将"查库 + 弹保存对话框 + 写文件"合并为一个 Rust 命令（如 `db_export_words_csv_dialog`）：命令内部用 `with_db_read` 拿连接、生成 CSV/Anki 字符串后直接通过 `DialogExt` 选路径并写盘，只把最终路径返回 WebView。`write_text_file_dialog` 可保留给非数据库文本导出。

**状态**：已确认（调用链核实）；实际耗时取决于词库规模，未做端到端计时。

---

### D-09（P2，疑似风险）重型结果窗口只有条数上限、没有总字节上限，极端数据下内存峰值可达数百 MB

**位置**
- `src-tauri/src/repository/history.rs:35-56`：单条 `input_text` 上限 1 MB、`result` 上限 5 MB、`graph_data` 上限 5 MB。
- `src/lib/db/history.ts:129-130`：`HISTORY_RECORD_LIMIT = 500`、`HISTORY_RESULT_LIMIT = 150`。
- `src-tauri/src/repository/history.rs:264`：`get_history_results_by_type` 的 limit 钳制到 1..=500。

**机制**
窗口只限制"多少条"，不限制"多少字节"：150 条 × 5 MB = **750 MB**（result 窗口理论峰值）；500 条 × 1 MB = **500 MB**（metadata 的 input_text，见 D-01）。真实场景下 LLM 结果/文章远小于上限，但上限本身允许这种数据写入（`add_history` 校验通过），随后 Analytics 每次加载都可能触碰。

**影响与建议**
- 影响：极端但合法的用户数据可导致 IPC 序列化 OOM/主线程长时间解析；属于"疑似"风险，需真实数据分布验证。
- 建议：窗口查询增加字节预算——例如在 SQL 侧计算 `SUM(length(result))` 并分页/截断，或对列表/分析路径限制单条 `length(result) <= N`，超出则标记为需详情页查看。`get_recent_correct_results`（20 × 5 MB = 100 MB）同理。

**状态**：已确认上限结构；实际触发概率与影响量级为疑似，待真实数据测量。

---

### D-10（Info）`idx_words_level` 未被任何 SQL 查询使用

**位置**
- `src-tauri/migrations/001_init.sql:55`：`CREATE INDEX idx_words_level ON words(level)`。
- 全仓库 Rust SQL 检索：没有任何 `WHERE level = ...` / `level IN (...)` 查询；等级筛选在前端完成（`src/pages/VocabularyPage.tsx:361-364` `words.filter(w => !filterLevel || w.level === filterLevel)`）。

**说明**
索引目前只增加每次 `words` 写入的维护成本（很小）并占用空间；若未来把等级筛选下推到服务端即可复用。当前可保留（成本可忽略）或删除。Info 级别，无需优先处理。

---

### D-11（Info）`build_tts_config` 每次读取 TTS 配置拆成两次 SQL

**位置**
- `src-tauri/src/repository/settings.rs:55-76`：`get_tts_settings` 用一次 `WHERE key IN (4 个 key)` 查询。
- `src-tauri/src/commands/settings.rs:69-70`：又单独 `get_setting("tts_dialect")`，共两次查询。

**说明**
结果在前端 `getTTSConfigCached`（`src/lib/db/tts.ts:35-37`）缓存，只有设置变更/首读时触发；两次查询均为 `settings` 主键等值查询，微秒级。可将 dialect 并入 `get_tts_settings` 的 key 列表省一次查询，属于可选的整洁性优化。

---

## 已排除项（已核实为合理/非问题）

1. **单类型历史查询的索引使用正确**：`WHERE type = ? ORDER BY created_at DESC LIMIT` 实测走 `idx_history_type_date` 且无临时排序；无过滤的 `ORDER BY created_at DESC` 走 `idx_history_created`（迁移 010 恢复）；`get_history_oldest_date`（`history.rs:232-240`）走 covering index + LIMIT 1，实测为 `SCAN ... USING COVERING INDEX idx_history_created`，只需读一行。
2. **`add_word` 的 `lower(word)` 唯一索引确实可用**：`WHERE lower(word) = lower(?1)` 实测 `SEARCH words USING INDEX idx_words_word_lower (<expr>=?)`，不是全表扫描；迁移 013 的索引目标达成。
3. **`graph_data`/`result` 已被排除在列表查询之外**：`history.rs:75` 用 `'' AS result, NULL AS graph_data`；`get_history_by_id`（`history.rs:168`）显式 `NULL AS graph_data`；知识图谱另走 `get_history_graph_data`（`history.rs:181-190`）按需读取。这部分设计良好。
4. **SQLite 连接参数合理**：`src-tauri/src/db.rs:29-43` 设置 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`；连接池 `max_size(5)`、`min_idle(1)`、`connection_timeout(10s)` 与并发读设计一致，未发现锁粒度问题（单个写事务都是单行短事务；批量导入的锁churn见 D-03）。
5. **启动迁移不是每次启动做重活**：`run_migrations`（`db.rs:152-263`）通过 `_migrations` 版本表跳过已应用迁移，每次启动只读 14 行版本 + 逐条 checksum 校验（`db.rs:227-247`，14 次小型 SELECT）；`migrate_api_key_column`（`db.rs:310-322`）用 `PRAGMA table_info(models)` 先短路，列不存在时直接返回；`_migrations` 的 `ALTER TABLE ADD COLUMN checksum` 以 duplicate column 错误做幂等短路（`db.rs:160-167`）。真正的全表重活只发生在一次性升级迁移中（010 回填、011 时区转换、013 去重建索引），不是启动常态。
6. **缓存没有无界增长**：`createCachedFetcher`（`src/lib/cache.ts:53-60`）默认 `maxSize=0`（不驱逐），但实际使用方 `defaultModelCache`（`src/lib/db/models.ts:52`）与 `ttsConfigCache`（`src/lib/db/tts.ts:35`）都是无参单 key 缓存，最多 1 条；`personalizedContextCache`（`src/lib/db/history.ts:240-261`）显式 `maxSize:4` + `ttlMs:60_000`，无泄漏风险。
7. **写操作的事务/原子性**：`add_model`（`repository/models.rs:107-136`）、`set_default_model`（`:220-243`）、`update_model`（`:249-322`）、`set_tts_settings_batch_tx`（`commands/settings.rs:115-156`）均使用事务或有补偿逻辑；`restore_db`/`backup_db` 走 SQLite Backup API 并在恢复前 checkpoint（`repository/export.rs:118-187`），不是简单的文件拷贝。
8. **Dashboard 的多个查询是并行而非串行**：`DashboardPage.tsx:149-172` 用 `Promise.all` 一次发起 7 个异步调用（含 3 个 `getHistoryWithResults`），没有串行等待；每次 `getHistoryWithResults` 内部也是 `Promise.all` 两个查询（`history.ts:184-191`）。因此"Dashboard 多次串行 invoke"不成立。可优化点仅在 IPC 数量本身（约 10 次，见 D-04/D-07）。
9. **生产 SQL 不存在 `SELECT *`**：repository 全目录检索无 `SELECT *`；字段均显式列出。
10. **`learning_goals`/`learning_streaks`/`settings` 均为小表**，PK/自增索引够用，无需额外索引；`models` 表规模为个位数，无索引缺口。

---

## 建议的测量方法（按优先级）

1. **SQL 层：`EXPLAIN QUERY PLAN` 固化**
   - 对 `get_history_list`（单类型/多类型/无过滤）、`get_history_results_by_type`、`get_recent_correct_results`、`get_words`（无搜索/搜索）、`get_review_words`、`get_review_stats` 分别执行 `EXPLAIN QUERY PLAN`，断言"是否出现 `USE TEMP B-TREE FOR ORDER BY`"及使用的索引名。
   - 用真实 `raven.db` 的副本运行（避免污染用户库），并在 `PRAGMA optimize`/`ANALYZE` 后对比计划是否变化（当前仓库没有 ANALYZE 调用）。
2. **Rust 侧耗时打点**
   - 在 repository 各函数入口/出口用 `std::time::Instant` + `tracing::debug!` 记录 `elapsed_us`（或临时使用 `tracing::span`），重点看 `get_history_list`、`get_words`、`get_review_stats`、`get_sidebar_data`、`add_word`。这能直接区分"SQL 慢"还是"IPC/serde 慢"。
3. **IPC 载荷测量**
   - 在 `HistoryDto`/`WordDto` 序列化前后记录 `serde_json::to_vec(&dto).len()`；或在 Tauri 命令返回前累计字节数。对比 D-01/D-02 的估算，确认真实窗口大小。
   - DevTools Performance 面板观察 `invoke` resolve 后主线程 JSON.parse 的耗时（Tauri 的 IPC 反序列化会占用 WebView 主线程）。
4. **构造规模数据**
   - 测试库：words 1k/5k/10k，history 1k/10k/50k，`input_text` 1KB/5KB/10KB 三档；分别测首屏、翻页、搜索、单条增删改后的端到端耗时。
   - 重点验证 D-02（词库 5k+ 的刷新）、D-04（history 多类型窗口）、D-03（导入 200/1000/5000 行）。
5. **写事务放大**
   - 用 `PRAGMA wal_autocheckpoint`/`page_count` 观察逐事务导入后的 WAL 大小；用 `sqlite3 .timer on` 对比逐事务 vs 单事务差距（D-03 已给探针结果，可作为基线）。
6. **回归基线**
   - 建议把上述 EXPLAIN 与规模数据测量做成 `src-tauri` 的 `#[cfg(test)]` 集成测试或独立 benchmark（不进 CI 主流程），在每次新增迁移/索引后复核计划，避免 008 注释里的 O4 校验只停留在注释层。

---

*本报告仅做只读代码审查，未修改任何源码；所有 file:line 均以当前工作副本为准。*
