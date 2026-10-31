# P1 性能修复落地记录

- **执行日期**：2026-10-31
- **依据**：[00-performance-analysis.md](00-performance-analysis.md) 第 1 节 P1 清单
- **范围**：10 项 P1（S-01、D-01、D-02、D-03/H-11、H-10/S-17、H-05/P-01、P-02、P-03、H-20/P-07、S-06、S-12），含必要的单元测试更新
- **状态**：全部落地；未包含 P2 清单（另行排期）

---

## 1. 结果总览

| P1 | 状态 | 变更要点 |
| --- | --- | --- |
| S-01 首屏误加载 recharts | ✅ | `vite.config.ts` 新增 `vendor-utils` 分组（`clsx` / `tailwind-merge` / `use-sync-external-store`），charts 不再进入首屏依赖图 |
| D-01 历史列表携带完整 `input_text` | ✅ | `get_history_list` SQL 用 `substr(input_text, 1, 200)`；详情查询保持全文 |
| D-02 生词本全量加载/全量刷新 | ✅ | 新增 `db_get_words_page`（分页 + total + 搜索 + level 筛选）与 `db_get_word_stats`（聚合统计）；VocabularyPage 改为分页 + 局部更新 |
| D-03 / H-11 CSV 逐行 IPC | ✅ | 新增 `db_add_words_batch`（单事务批量插入）；导入按 50 行/块调用，不再预读全量词表 |
| H-10 / S-17 批量补全串行 | ✅ | `runBatch` 支持 `concurrency`（默认 1），批量补全并发 3；`enrichWord` 透传 `AbortSignal`，卸载/取消时真正中止在途请求 |
| H-05 / P-01 ReadingPage 逐词 DOM | ✅ | `OriginalText` 拆出 `SentenceRow = memo`，token 数组预计算；切句只重渲染高亮句 |
| P-02 / P-03 LevelCard 大窗口 + 重复解析 | ✅ | `useHistoryWindow` 支持自定义窗口；LevelCard 改用 200/80；解析与估级拆两级 memo |
| H-20 / P-07 CorrectPage 流式全文预览 | ✅ | `StreamPreview` 增加 2000 字符尾部截断与代理对修正 |
| S-06 abort 不取消 Rust 请求 | ✅ | Rust 新增 `StreamCancelRegistry` + `cancel_stream_chat`；SSE 泵用 `CancellationToken` 立即停止；前端 abort 时按 `requestId` 取消 |
| S-12 TTS 朗读逐句串行 | ✅ | 新增 `prefetchTTS`；`useReadAloud` 播放第 i 句时预取第 i+1 句 |

---

## 2. 逐项变更

### S-01 首屏包体（`vite.config.ts`）

`codeSplitting.groups` 新增最高优先级 `vendor-utils` 组：

```ts
{
  name: "vendor-utils",
  test: /node_modules[\\/](clsx|tailwind-merge|use-sync-external-store)[\\/]/,
  priority: 4,
}
```

原因：`vendor-charts` 组的 `includeDependenciesRecursively`（默认 true）会把 recharts 的依赖 `clsx`、`use-sync-external-store` 一并收进 charts 组；而入口/`button` 也依赖这两个模块（`cn()` 与 `@base-ui/react`），最终导致入口静态依赖整块 recharts。

**构建验证**（重新 `npm run build` 后）：

- `dist/index.html` 的 `modulepreload` 列表**不再包含** `vendor-charts-*.js`；
- 入口/button 不再静态 import `vendor-charts`；
- 首屏 eager 资源（JS + CSS）从 **972,399 B** 降到 **550,746 B**，减少 **421,653 B（约 412 KiB）**；gzip 约从 **285 KB** 降到 **168 KB**（构建输出汇总，约 -117 KB）。

### D-01 历史列表截断（`src-tauri/src/repository/history.rs`）

`get_history_list` 的字段列表改为：

```sql
id, type, substr(input_text, 1, 200) AS input_text,
'' AS result, NULL AS graph_data, difficulty_level, created_at
```

同步更新 `query_history` 的 `ALLOWED_FIELDS` 白名单；`get_history_by_id` 保持完整 `input_text`，详情页不受影响。Rust 测试覆盖「列表返回前 200 字符 / by-id 返回全文」。

### D-02 生词本分页与统计（Rust + 前端）

新增：

- `repository::words::get_words_page(conn, limit, offset, search, level) -> WordPageDto`
  - limit 缺省 100、钳制 1..=500；`total` 用同 WHERE 条件的 `COUNT(*)`；
  - 搜索匹配 word/definition/phonetic（不区分大小写），level 为 AND 关系。
- `repository::words::get_word_stats(conn) -> Vec<WordLevelStatDto>`
  - `GROUP BY level, review_status`，未标记等级返回 `level = None`。
- Tauri commands：`db_get_words_page`、`db_get_word_stats`（已注册到 `lib.rs`）。
- TS：`getWordsPage`、`getWordStats` 与类型 `WordPage/WordLevelStat`（`src/lib/db/words.ts`，barrel 导出）。

`VocabularyPage`：

- 首屏/搜索/等级筛选统一走 `getWordsPage({ limit: 100, offset, search, level })`；
- “显示更多”按已加载条数作 offset 追加下一页，并显示 `已显示 x / total`；
- 删除/改等级/单条补全成功后局部更新 `words`，统计用 `getWordStats()` 刷新，不再全量 `getWords()`；
- 新增/导入后只重载第一页。

### D-03 / H-11 CSV 批量导入（Rust + 前端）

- 新增 `repository::words::add_words_batch(conn, inputs) -> Vec<BatchWordResultDto>`：
  - 整批一个 `BEGIN IMMEDIATE` 事务；
  - 抽出 `validate_new_word` / `insert_word_if_absent`，单条校验失败只写该条 `error` 并继续；
  - 已存在（含大小写变体）返回已有 id + `inserted = false`。
- 新增 command `db_add_words_batch`（已注册）。
- `use-vocabulary-import` 移除导入前 `getWords()` 全量去重基线，改为 50 行/块 `addWordsBatch`；用 `inserted` 判重、`error` 计失败；缺释义条目在批量插入后补全。

### H-10 / S-17 批量补全并发与取消

- `batch-processor.ts`：新增可选 `concurrency`（默认 1，完全向后兼容），worker pool + 按完成数回调进度。
- `use-batch-enrich.ts`：并发 3；创建 `AbortController`，卸载时 abort；`enrichWord(word, signal)`。
- `vocabulary-enrichment.ts`：`signal` 透传到缓存 fetcher 与 `streamChatAsync`；缓存 key 仍为 `word.toLowerCase()::model.id`（signal 不入 key）。文档记录共享 Promise 的取消语义。
- 测试覆盖并发、取消与空字段失败计数。

### H-05 / P-01 ReadingPage 逐词 DOM

- `OriginalText` 拆出 `SentenceRow = memo(...)`；
- 父级 `useMemo` 预计算 `splitSentences(input).map(s => s.split(/(\s+)/))`；
- 切句只改变 active 行的 `active` prop，其余行的 `tokens`/`onWordClick` 引用稳定，memo 跳过；
- 顺带落地 H-06：原文区延迟到 `!loading` 挂载，避免流式首个 token 就构建整篇词表（流式期间输入仍由 TextInput 保留）。

### P-02 / P-03 LevelCard 窗口与解析 memo

- `useHistoryWindow(options?: { recordLimit?, resultLimit? })`：默认仍为 500/150；`useAnalytics` 不传参数，行为不变；`resultsWindowLimited` 按本次 resultLimit 判断。
- `useLevelEstimation` 使用 `LEVEL_ESTIMATION_RECORD_LIMIT = 200`、`LEVEL_ESTIMATION_RESULT_LIMIT = 80`；导出供 LevelCard 文案使用。
- 解析拆两级：`useMemo(() => groupAndParseResults(records, resultById), [records, resultById])` + `useMemo(() => buildSkillEstimates(parsed, level), [parsed, level])`；切换级别不再重复 JSON.parse + Zod。

### H-20 / P-07 CorrectPage 流式预览

- `STREAM_PREVIEW_TAIL_CHARS = 2000`，只渲染末尾片段，处理 UTF-16 孤立低代理项；
- 流式截断时显示「生成中…仅显示末尾」，完整结果解析路径不变。

### S-06 真正取消 Rust 流式请求

- `src-tauri/Cargo.toml` 增加 `tokio-util`（`rt` feature）；
- `proxy.rs`：`StreamCancelRegistry`（request id → `CancellationToken`），`stream_chat_completions` 新增可选 `request_id`；新增 command `cancel_stream_chat`；
- `sse.rs`：`pump_sse_stream` 用 `tokio::select!` 监听取消，取消后立即返回，不再读上游/发 token/Done/Error；
- `lib.rs`：`app.manage(StreamCancelRegistry::default())` + 注册 `cancel_stream_chat`；
- `services/llm.ts`：每次请求生成唯一 `requestId`，abort 时调用 `cancel_stream_chat`；
- 测试：Rust 注册/取消/替换单测；前端断言 invoke 携带 requestId 且 abort 触发取消。

### S-12 TTS 预取

- `services/tts.ts` 导出 `prefetchTTS(text, opts?)`：复用配置与 `audioUrlCache` 键，失败静默；
- `useReadAloud`：开始朗读预取第 1 句；播放第 i 句时预取第 i+1 句；
- 单测覆盖缓存命中、未配置静默、失败静默。

---

## 3. 验证证据

| 命令 | 结果 |
| --- | --- |
| `npm test` | **107 files / 1592 tests passed**（0 failed） |
| `npm run lint`（biome check） | **273 files checked，无错误** |
| `npm run build`（`tsc -b && vite build`） | 成功；`dist/index.html` 不再 preload `vendor-charts` |
| `cargo test --lib` | **261 passed / 0 failed** |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `cargo fmt -- --check` | 通过 |
| `git diff --check` | 通过 |

最终首屏 eager 资源：**550,746 B（JS + CSS）**，修复前为 **972,399 B**；减少 **421,653 B（约 412 KiB）**。其中 `vendor-charts` 从首屏消失（424.5 KB → 按需加载），新增 `vendor-utils` 约 36.5 KB。

---

## 4. 行为变化与注意事项

1. **ReadingPage 流式期间不显示原文区**：原文逐词按钮改为 `result && !loading` 才挂载；流式期间只显示分析预览与 TextInput。若产品要求流式期间也展示原文，可将条件改回 `result &&`，不影响其他修复。
2. **LevelCard 被动估计窗口缩小为 200 条元数据 / 80 条 result**（原 500/150）。估计引擎本身有置信度与样本量语义，200/80 足够覆盖近期练习；截断文案使用新常量。
3. **CSV 导入进度粒度变为“块”**（50 行/块），进度文案 `导入中 x/y` 的 y 是块数而非行数；最终汇总仍按行统计成功/重复/失败。
4. **S-06 的取消是“尽力而为”**：前端 abort 后调用 `cancel_stream_chat`；若请求尚未在 Rust 注册（极早 abort）或已完成清理，取消命令静默无操作。正常长生成过程中取消会立即停止上游读取。
5. **批量补全的 signal 绑定共享缓存 Promise**：同一「单词+模型」若同时被批量与单条调用，批量 abort 会中止共享请求；单条补全默认不传 signal。该语义已在服务层文档说明。
6. 未执行 P2 清单（如多类型历史查询临时排序、SSE token 合并、TTS 缓存按字节、ASR base64 等）。

---

## 5. 变更文件清单

**Rust / 构建**

- `vite.config.ts`
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/{history,proxy,sse,words}.rs`
- `src-tauri/src/dto.rs`
- `src-tauri/src/repository/{history,words}.rs`
- `src-tauri/src/db.rs`（测试 helper 的 clippy `let_and_return` 修正）

**前端**

- `src/lib/db/{index,history,words}.ts` + `words.test.ts`
- `src/services/{llm,tts,vocabulary-enrichment}.ts` + tests
- `src/hooks/{use-read-aloud,use-history-window,use-level-estimation}.ts` + tests
- `src/pages/{ReadingPage,CorrectPage}.tsx` + tests
- `src/pages/settings/LevelCard.tsx` + test
- `src/pages/VocabularyPage.tsx` + test
- `src/pages/vocabulary/{use-vocabulary-import,use-batch-enrich,batch-processor,use-batch-runner}.ts` + import/enrich tests

**未改动**：数据库 schema / migration（无需迁移）；P2 项；分析报告原文（另加状态说明）。
