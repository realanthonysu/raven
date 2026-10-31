# 性能分析 D：重点页面热路径审查报告

- **项目**：Raven（Tauri v2 + React 19 + TypeScript + Rust/rusqlite）
- **审查范围**：AnalyticsPage、ReadingPage + KnowledgeGraph、VocabularyPage + pages/vocabulary/**、DashboardPage、HistoryPage、HistoryDetailPage、SpeakingPage + pages/speaking/**、ListeningPage、ExercisePage、CorrectPage、ReviewPage 及对应 hooks。
- **审查方式**：只读静态代码审查（read/grep/glob），未修改任何源码，**未运行构建/测试**（按要求避免与其他人抢资源）。
- **证据约定**：`file:line` 均为当前工作区实际行号（已逐条读源码核对）；所有量级估算均为静态推算，不是实测值。
- **严重级定义**：
  - **P0**：有明确代码证据、对常规用户可感知的卡顿/内存增长/功能受阻；
  - **P1**：特定数据量或长文本场景可感知；
  - **P2**：轻微优化；
  - **Info**：已优化或无需处理。

## 摘要

| 严重级 | 数量 |
| --- | --- |
| P0 | 0 |
| P1 | 4 |
| P2 | 18 |
| Info（已排除项另列） | 11 |

**结论**：页面层没有发现会阻断功能的 P0 级问题；多数页面已经做了针对性优化（ReadingPage 流式 tail 截断、ExerciseCard/TextInput/MarkdownContent memo、Analytics 解析一次、KnowledgeGraph 实例不随父级重渲染重建）。剩余热点集中在四类：

1. **流式全文渲染**：CorrectPage 的流式预览直接渲染完整累积 JSON（没有采用 ReadingPage 的尾部截断），长文纠错时是 O(n²) 级别的文本布局成本（H-20）。
2. **长文逐词 DOM**：ReadingPage 的 `OriginalText` 为每个空白 token 建一个 `<button>`，且朗读换句时整篇重新 split + 重建（H-05/H-06）。
3. **串行批处理**：Vocabulary 批量补全与 CSV 导入都是逐词/逐行串行 LLM + IPC，且进度 state 每项触发整页重渲染（H-10/H-11/H-12）。
4. **非持久化重页面重复加载**：Analytics（500 元数据 + 150 result）与 Dashboard（7 个查询 + 70 条 result 解析）每次进入都重新做一遍，页面级解析在主线程（H-01/H-15）。

---

## 1. AnalyticsPage + hooks/use-analytics/**

### H-01 [P2] 首次进入 Analytics 的全窗口加载 + 主线程 result 解析

- **位置**：`src/hooks/use-history-window.ts:75-80`（一次 `getHistoryWithResults`：6 类元数据 × 500 条 + 5 类 result × 150 条）；`src/hooks/use-analytics/index.ts:177-180`（`parsedAll` → `groupAndParseResults`）；`src/lib/level-estimation-samples.ts:220-241`（逐条 `extractJsonSafe` = JSON.parse + Zod safeParse）；`src/pages/AnalyticsPage.tsx:141-143`（解析完成前整页 `LoadingIndicator`）。
- **机制**：AnalyticsPage 是非持久化路由（`src/components/PersistentRoutes.tsx:206-207` 只对非持久化路径渲染 `<Outlet />`），每次从侧边栏进入都会重新挂载，重新拉取 500 条元数据 + 150 条重型 result，并在主线程逐条 `JSON.parse` + Zod 校验。
- **触发条件**：每次进入 `/analytics`；历史记录越多、写作 result 越大越明显。
- **量级估算**：最坏 150 条 result。按写作 result 10–30KB、其他 2–8KB 估算，IPC 载荷约 0.5–2MB、150 次 JSON.parse + Zod；主线程额外约 50–300ms（未实测），期间页面只有 loading 指示。
- **建议**：先渲染元数据统计（只依赖 500 条轻量记录）再异步解析 result；解析结果按会话缓存或移入 Web Worker；窗口大小按实测 p95 调优。
- **确认度**：机制已确认；耗时量级待实测。

### H-02 [P2] 时间范围切换只免 JSON.parse，仍重跑多路排序/聚合

- **位置**：`src/hooks/use-analytics/index.ts:184-196`（`parsedByType` 过滤生成 4 个新数组）；`src/hooks/use-analytics/use-writing-analytics.ts:57-71`（复制 + 排序 + 逐条 `parseDbTimestamp`/`toLocaleDateString`）；`src/hooks/use-analytics/use-exercise-analytics.ts:57-73`（同）；`src/hooks/use-analytics/use-listening-analytics.ts:30-46`；`src/hooks/use-analytics/use-speaking-analytics.ts:28-42`；`src/hooks/use-analytics/use-recent-sessions.ts:62-65`（500 条记录全排序）；`src/hooks/use-analytics/index.ts:243-263`（`weakCategories` 再复制排序 `parsedCorrect`）。
- **机制**：`days` 变化 → `parsedByType` 产生新数组 → 所有子 hook 的 `useMemo` 依赖失效 → 每次切换都要重做 5 次以上 O(n log n) 排序、大量 `parseDbTimestamp`（每次 `new Date`）与 `toLocaleDateString`。
- **触发条件**：点击 7天/30天/90天/全部。
- **量级估算**：150 条已解析记录 + 500 条元数据；单次约数千次 Date 构造 + 排序，估算 5–30ms（随机器波动）。**不会重新 JSON.parse**（这一点确认优化到位，见已排除项 5）。
- **建议**：日期时间戳只解析一次（`Map<recordId, number>`）；把排序后的时间线按 record id 缓存，切换范围只做区间截取。

### H-03 [P2] 页面局部 state 变化触发全部图表/卡片重渲染

- **位置**：`src/pages/AnalyticsPage.tsx:136-139`（`days` / `wrongQuestionsShown` 两个 state 都在页面顶层）；`src/pages/AnalyticsPage.tsx:529-563`（点击“展开更多”只增加错题展示数）；`src/pages/AnalyticsPage.tsx:99-123`（`ScoreTrendChart` 未 memo）；`src/pages/AnalyticsPage.tsx:388-415`（三处 `formatValue={(value) => ...}` 每次渲染都是新函数，即使给 ScoreTrendChart 加 memo 也会被击穿）；`src/pages/AnalyticsPage.tsx:76-83` + `350`/`376`（`categoryCells` 每次重建 Cell 数组）。
- **机制**：`wrongQuestionsShown` 与错题本有关，但 state 提升在 AnalyticsPage 顶层；点击“展开更多”会让整页（9 个 StatCard、7 个 recharts 图表、近期记录、错题本）全部重渲染。`ScoreTrendChart` 因内联 `formatValue` 无法用 memo 隔离。
- **触发条件**：点击错题本“展开更多”；点击时间范围按钮（后者本身也需要刷新）。
- **量级估算**：7 个图表容器 + 9 张卡片；图表数据引用稳定时 recharts 通常跳过 scale 重算，但 React reconcile + `ResponsiveContainer` 尺寸测量仍会发生，单次约几毫秒到十几毫秒。
- **建议**：错题本拆成独立组件并 memo；`ScoreTrendChart` 加 `memo` 且 `formatValue` 提升为模块级常量；`categoryCells` 结果 useMemo。

### H-04 [P2] useWritingAnalytics 的聚合未 memo

- **位置**：`src/hooks/use-analytics/use-writing-analytics.ts:38-40`（`totalArticles`、`totalErrors` 的 reduce、`avgErrors` 的除法在函数体每次执行）。
- **机制**：`useWritingAnalytics` 每次渲染都会遍历 `parsed` 的全部 corrections 重新求和；而 `parsed` 本身已由上游 memo 稳定，这三个标量完全可以直接 memo。
- **触发条件**：AnalyticsPage 任意 state 更新（如“展开更多”、days 切换）。
- **量级估算**：≤150 篇 × 每篇约 10–40 条 corrections ≈ 1.5k–6k 次数组访问，通常 <1ms，属轻微优化。
- **建议**：`useMemo(() => {...}, [parsed])`，或并入 `allCategories` 的 memo。

---

## 2. ReadingPage + KnowledgeGraph + 相关 hooks

### H-05 [P1] OriginalText 朗读逐句全量重建（含每句重新 split）

- **位置**：`src/pages/ReadingPage.tsx:99-133`（`OriginalText` memo 组件）；`src/pages/ReadingPage.tsx:118-130`（render 内对**每一句**执行 `sentence.split(/(\s+)/)`，并为每个 token 生成一个 `<button>`）；`src/hooks/use-read-aloud.ts:44-52`（每句 `setCurrentSentenceIndex(i)`）；`src/pages/ReadingPage.tsx:355-359`（`currentSentenceIndex` 作为 prop 传入）。
- **机制**：`OriginalText` 的 memo 被 `currentSentenceIndex` 打破。朗读每进入下一句，整个组件重渲染，渲染过程中对整篇文章的所有句子重新 split、重新创建所有单词按钮（包括空白 token），实际目的只是给当前句的 `<span>` 加一个高亮 class。
- **触发条件**：长文章点击“朗读”，逐句播放过程中；文章越长、句子越多越明显。
- **量级估算**：2,000 词文章约 3,000–4,000 个 whitespace token/button；100 句 → 一次朗读约 30–40 万次元素创建/协调。若单句渲染 3–15ms，每个句间切换都可能掉帧；10,000 词文章会到 2 万级 button，单次可达 50ms+。
- **建议**：预计算并 `useMemo` 每句的 tokens 数组（`[sentenceIndex, tokens]`）；高亮改为只重渲染当前句组件，或通过 CSS class/变量切换；避免在渲染期重新 split。

### H-06 [P2] 首个流式 token 即挂载整篇逐词 DOM

- **位置**：`src/pages/ReadingPage.tsx:331-359`（原文区条件为 `{result && ...}`，流式期间 result 一旦非空就成立）；`src/pages/ReadingPage.tsx:399`（流式预览只在 loading 时显示）。
- **机制**：`handleSubmit` 后约 50ms 第一次 flush 得到非空 `result`，立即挂载 `OriginalText`，整篇文章的数千个按钮在流式过程中一次性同步创建。
- **触发条件**：每次提交长文章分析。
- **量级估算**：与 H-05 相同的 DOM 规模；首次挂载可能是一次 30–150ms 的长任务，用户表现为“开始分析瞬间”的停顿，与 token 流并发。
- **建议**：分析完成（`!loading`）后再挂载逐词交互层；流式期间先渲染纯文本。

### H-07 [P2] KnowledgeGraph 的 ResizeObserver 每次回调 resize+fit

- **位置**：`src/components/knowledge-graph/use-cytoscape-graph.ts:322-340`（effect 内先 `cy.resize(); cy.fit()`，`ResizeObserver` 回调里再次 `resize()+fit()`）。
- **机制**：窗口拖拽、布局变化、全屏切换时容器尺寸每次变化都会触发 observer；`fit()` 需要遍历全图计算包围盒并更新视口。全屏 CSS 过渡期间 observer 可能连续触发多次。
- **触发条件**：图谱展开时拖动窗口大小、切换全屏。
- **量级估算**：节点数几十到几百，每次 `fit` 为 O(V+E)；60Hz 拖拽下每秒约 60 次。几十节点通常 <1ms，数百节点可能可感知。
- **建议**：observer 回调用 `requestAnimationFrame` 合并或 trailing 防抖（如 100ms），过渡结束再 fit 一次。

### H-08 [P2] 持久化隐藏页保留重型 DOM / Cytoscape 最长 10 分钟

- **位置**：`src/components/PersistentRoutes.tsx:28-31`（`HIDDEN_UNMOUNT_TTL_MS = 10 分钟`）、`94-97`（注释明确说明保留 result/Cytoscape/DOM 的取舍）、`199-204`（`display: none` 保持挂载）；`src/pages/ReadingPage.tsx:331-359`（整篇原文逐词 DOM）；`src/components/KnowledgeGraph.tsx:124-133`（Cytoscape 容器）。
- **机制**：离开 `/reading` 后页面不卸载，整篇文章的数千按钮、分析 Markdown、Cytoscape canvas/实例持续驻留内存，最长 10 分钟后才因 TTL 卸载；期间闭包、Audio 对象与流式结果也保留。
- **触发条件**：长文章并打开过知识图谱后，切换到其他页面。
- **量级估算**：数千 DOM 节点 + Cytoscape 画布（随节点数约数百 KB 到数 MB）；低配机可感知内存压力。
- **建议**：保留 TTL 设计；可进一步在隐藏时卸载 `KnowledgeGraph` 实例（保留 graphData），或把逐词原文折叠为纯文本。

### H-09 [P2] 阅读提交串行等待语言检测 LLM

- **位置**：`src/pages/ReadingPage.tsx:226-238`（`await detectLanguage(input)` 成功后才 `handleSubmit(input)`）；`src/hooks/use-language-detection.ts:31-69`（`streamChatAsync` 非流式调用）。
- **机制**：每次提交先完成一次独立 LLM 语言检测请求，再发起正式六维分析；两段串行。
- **触发条件**：每次点击 Start Reading。
- **量级估算**：额外一次 LLM RTT（通常 0.5–3s），首 token 时间整体后移；与文章长度无关。
- **建议**：本地启发式快速判定英文（如 ASCII 字符比例），LLM 检测作为兜底；或在用户输入时预检测。

---

## 3. VocabularyPage + pages/vocabulary/**

### H-10 [P1] 批量补全严格串行 LLM 调用

- **位置**：`src/pages/vocabulary/batch-processor.ts:36-71`（`for` 循环逐条 `await`，单条失败继续下一条）；`src/pages/vocabulary/use-batch-enrich.ts:48-75`（`run` + `enrichWord`）；`src/services/vocabulary-enrichment.ts:83-89`（每次 `enrichWord` → `getDefaultModelCached` + LLM 请求）。
- **机制**：没有并发池、没有速率限制；一个词补全完成后才处理下一个词，每词一次完整 LLM 请求（未命中缓存时）。`cancelledRef` 只在条目之间检查，已发起的请求不会中止。
- **触发条件**：词库中大量词缺音标/释义时点击“批量补全”。
- **量级估算**：N 个词 ×（1 次 LLM 往返，典型 1–10s）；100 词约 2–15 分钟，500 词可到数十分钟。属于特定数据量下明显可感知的长任务（P1）。
- **建议**：并发池 2–4（配合 LLM rate limit），或提供后端批量接口；进度显示预计剩余；为每条请求传 `AbortSignal`。

### H-11 [P1] CSV/TXT 导入逐行串行 IPC + 逐词 LLM

- **位置**：`src/pages/vocabulary/use-vocabulary-import.ts:102-159`（`run(dataLines, ...)` 中每行 `addWord` 串行，缺释义时再 `enrichWord`）；`src/pages/vocabulary/batch-processor.ts:47-68`；`src/pages/vocabulary/use-batch-runner.ts:71`（每行 `setProgress`）。
- **机制**：每行至少 1 次 Tauri IPC（`addWord`）；若 CSV 只含单词/音标（无释义），每行再加 1 次 LLM 补全 + 1 次 `updateWordEnrichment` IPC。加词、富化、进度全部串行。
- **触发条件**：导入几百行 CSV/TXT。
- **量级估算**：500 行无释义 → 500 次 IPC + 500 次 LLM（最坏 8–80 分钟）；即使每行都有释义，也至少 500 次串行 IPC（数秒级）+ 500 次整页重渲染（见 H-12）。P1。
- **建议**：新增批量插入命令（事务内一次插入多行）；先批量 `addWord` 再批量 `enrich`（并发池）；进度按批合并更新。

### H-12 [P2] 批次进度每 item 触发整页重渲染

- **位置**：`src/pages/vocabulary/use-batch-runner.ts:62-79`（`onProgress` 每处理一项就 `setProgress`）；`src/pages/VocabularyPage.tsx:708-778`（当前最多 100 张词卡，每卡 11 个等级按钮 + SpeakButton/删除/补全按钮）。
- **机制**：`progress` 是页面级 hook 的 state，任何批量（补全/导入）每完成一项都 setState → VocabularyPage 整页重渲染，包含上千个按钮。
- **触发条件**：批量补全或 CSV 导入执行期间。
- **量级估算**：100 张卡 ×（11 等级按钮 + 朗读 + 删除 + 补全）≈ 1,300+ 按钮；500 行导入 → 500 次全页 reconcile，累计数十万到百万级元素协调。
- **建议**：把进度条拆成独立订阅（局部组件/useSyncExternalStore）；词列表用 memo 隔离；进度更新节流到 100–200ms。

### H-13 [P2] 单词级操作后全量 getWords + 全列表刷新

- **位置**：`src/pages/VocabularyPage.tsx:205-208`（`refresh`）；`src/pages/VocabularyPage.tsx:159-176`（`loadWords` 调 `getWords(undefined, undefined, keyword)`，无 limit）；`src/pages/VocabularyPage.tsx:230-253`（删除/设置等级后 refresh）；`262-284`（单个补全后 refresh）。
- **机制**：每次标记等级、补全一个词或删除一个词，都重新拉取整个词库并 `setWords(loaded)` 生成新数组，导致整页词卡重新渲染。
- **触发条件**：逐个手动补全或调整等级（常见操作）。
- **量级估算**：5,000 词 × 每词约 0.3–1KB ≈ 1.5–5MB IPC/序列化；每次点击都有明显延迟（低配/远程磁盘更明显）。
- **建议**：操作成功后局部更新 state（patch 对应词条）；或按当前搜索窗口/分页重新查询。

### H-14 [P2] 整库加载与每渲染 O(n) 扫描

- **位置**：`src/pages/VocabularyPage.tsx:159-176` + `src/lib/db/words.ts:45-51`（limit 不传 → Rust `get_words` 返回全部，见 `src-tauri/src/repository/words.rs:113-119`）；`src/pages/VocabularyPage.tsx:450`（`words.some(needsEnrichment)` 在每次渲染内扫描整个 words）；`380-397`（`statRows` 扫描 `statsWords`，已 memo）。
- **机制**：挂载和清空搜索时加载整个词库；页面每次渲染（包括搜索框每键入一个字符）都会执行 `words.some(needsEnrichment)` O(n) 扫描。
- **触发条件**：词库数千词以上；搜索输入时。
- **量级估算**：10,000 词 ≈ 4–10MB IPC + 主线程反序列化；每次按键 O(10k) 字符串检查（约 <1ms/次，但叠加整页渲染）。机制已确认，规模依赖真实词库，标记为“规模敏感”。
- **建议**：`words.some(...)` 用 useMemo 派生；词库很大时分页加载 + 虚拟列表。

---

## 4. DashboardPage

### H-15 [P2] 每次挂载 7 条并行查询 + 主线程 70 条 result 解析，无缓存

- **位置**：`src/pages/DashboardPage.tsx:149-172`（`Promise.all` 7 个查询：reviewStats / streak / historyList(5) / writing 20 / exercise 50 / listening+speaking 5 / oldestDate）；`191-219`（`groupAndParseResults` + `parseExerciseAttempts` + `rankWeakCategories`）；`250-252`（挂载 effect）；`src/lib/exercise-stats.ts:162-178`（`parseExerciseAttempts` 内部逐条 `extractJsonSafe` = JSON.parse + Zod）。
- **机制**：Dashboard 非持久化，路由离开即卸载，每次回来重新执行 7 个 IPC；拿到数据后在主线程解析 20 条写作 result + 50 条练习 result（共 70 次 Zod），并做弱项聚合。
- **触发条件**：每次返回首页（`/`）。
- **量级估算**：75 条 result（估 200KB–1MB JSON）+ 70 次 Zod；解析约 30–150ms（未实测），叠加 IPC 等待。查询已并行（`Promise.all`），不是串行瀑布。
- **建议**：Dashboard 数据加短 TTL 缓存（参考 `personalizedContextCache`）；弱项分析按需只解析最近若干写作结果；练习掌握度解析可延后到用户点击进入弱项卡。

---

## 5. HistoryPage / HistoryDetailPage

### H-16 [P2] 删除后按“已加载总数 + 20”全量重拉

- **位置**：`src/pages/HistoryPage.tsx:121-133`（`refresh`：`getHistoryList(selectedTypes, records.length + PAGE_SIZE)`）；`144`（`handleDelete` 后调用）。
- **机制**：删除一条后为了保持分页深度，重新拉取“已加载条数 + 一页”的记录并整体 `setRecords`。
- **触发条件**：用户已点击多次“加载更多”（例如已加载 300–500 条）后删除任一条。
- **量级估算**：重新跨 IPC 传输 L+20 条轻量记录（含完整 `input_text`）；500 条时约数百 KB–数 MB，并触发整列表重渲染。P2。
- **建议**：删除成功后本地移除该条（`setRecords(prev => prev.filter(...))`），必要时补拉一页；或改为游标分页。

### H-17 [P2] 列表无虚拟化，且逐条渲染完整 input_text / 每渲染格式化日期

- **位置**：`src/pages/HistoryPage.tsx:180-222`（`records.map` 全量渲染）；`216-218`（`record.input_text` 完整放进 DOM，仅 CSS `line-clamp-2`）；`200-202`（每条 `parseDbTimestamp(...).toLocaleString("zh-CN")` 在 render 内）。
- **机制**：加载更多无上限，DOM 随已加载条数线性增长；每条卡片携带完整输入文本（可能是整篇文章），并每次渲染重新做日期本地化格式化。
- **触发条件**：长期使用后点击“加载更多”十几次，之后任意 state 变化（如删除、loadingMore）。
- **量级估算**：500 条 × 输入文本 1–10KB → 0.5–5MB 文本节点；每次 rerender 500 次 `toLocaleString` + 500 卡片 reconcile，估 50–300ms。
- **建议**：虚拟列表或固定窗口分页；列表查询返回截断 preview（或在数据层切片）；日期格式化一次缓存。

### H-18 [P2] ReadingDetail 一次渲染全部 Markdown 节 + 无条件拉取/解析 graph_data

- **位置**：`src/pages/HistoryDetailPage.tsx:183-203`（`parseSections` memo；`useEffect` 无条件 `getHistoryGraphData` 并 `extractJsonSafe`）；`217-227`（`Object.entries(sections).map` 全量 `ResultCard`，默认展开）；`246`（KnowledgeGraph 在 `graphData` 时挂载）。
- **机制**：阅读详情默认展开所有 6 个维度，ReactMarkdown 在挂载时对全部节做 parse→sanitize→render；`graph_data` 即使不展开图谱也会跨 IPC 拉取并 JSON 解析。
- **触发条件**：打开任意阅读历史详情（尤其长文章）。
- **量级估算**：20–50KB Markdown → 6 次 ReactMarkdown 解析（估 30–150ms）；graph JSON 数十 KB + Zod。P2。
- **建议**：`ResultCard` 默认折叠或按需渲染单节；`graph_data` 在用户展开图谱时再懒加载；Markdown 解析结果可缓存。

---

## 6. SpeakingPage / ListeningPage / ExercisePage

### H-19 [P2] 每次停止录音在主线程逐样本 WAV 编码

- **位置**：`src/pages/speaking/use-speaking-session.ts:142-161`（`stop()` → `transcribeRecording`）；`src/services/asr.ts:24-85`（`mixDownToMono` / `audioBufferToWav`；`78-82` 逐样本 `view.setInt16`，用 `for...of` 遍历 Float32Array）；`src/services/asr.ts:105-114`（decode）。
- **机制**：录音结束后在 WebView 主线程把解码后的 PCM 逐样本写成 WAV；采样率 44.1/48kHz，n 秒录音约 44.1k×n 个样本循环。
- **触发条件**：每次口语跟读停止录音（每句一次）。
- **量级估算**：10s 录音约 44 万样本，单次编码估 5–20ms；60s 上限约 260 万样本，估 30–100ms，可能导致“停止录音”瞬间掉帧。P2。
- **建议**：AudioWorklet/Worker 做重编码，或让 Rust 侧接收原始音频处理；至少改用索引循环替代 `for...of`。

**本组其余核实结论（无 P0/P1）**：

- `useRecording` 没有每秒计时器/高频 setState：`src/hooks/use-recording.ts:104-188` 只在 start/stop/auto-stop 时改变 `recording`，不存在录音期间每秒整页重渲染。
- ExercisePage 单题输入只重渲染该卡：`handleAnswer` 稳定 `useCallback`（`src/pages/ExercisePage.tsx:67-69`），`ExerciseCard` 为 memo（`src/components/ExerciseCard.tsx:69-75`），`userAnswers` 新数组但其他卡 props 不变。
- ListeningPage 输入走 reducer，每键整页重渲染但树很小（`src/pages/ListeningPage.tsx:179-181`、`341-347`），5 句规模无实质影响。
- SpeakingPage 的评估流没有 `onToken`（`src/pages/speaking/use-speaking-session.ts:180-202`），评估期间没有 20fps 的流式渲染；`recognizing/evaluating` 只有状态切换。

---

## 7. CorrectPage / ReviewPage

### H-20 [P1] 流式期间渲染完整累积文本预览（无 tail 截断）

- **位置**：`src/pages/CorrectPage.tsx:51-57`（`StreamPreview` 直接 `<p>{text}</p>` 渲染全部文本）；`src/pages/CorrectPage.tsx:132-135`（`parsed` 在 `loading` 时恒为 null）；`src/pages/CorrectPage.tsx:276`（`result && !parsed && <StreamPreview text={result} />`）；`src/hooks/use-llm-stream-page.ts:18`（`TOKEN_FLUSH_INTERVAL_MS = 50`，约 20fps）。
- **机制**：每次 token flush 把 result 追加后传给 `StreamPreview`；text 变化使 memo 失效 → 整段累积 JSON 文本重新渲染/布局。对比 ReadingPage 的同类预览已限制为末尾 2000 字符（`src/pages/ReadingPage.tsx:57-68`、`64-84`），CorrectPage 没有该保护。
- **触发条件**：任意写作纠错流式生成；文章越长、纠错条目越多越明显。
- **量级估算**：纠错 JSON 通常 10–50KB；60 秒流式约 1,200 次 flush，累计文本布局量按 O(n²) 增长（约几十到上百 MB 字符处理）；长文/低配机可能掉帧。P1（长文本可感知）。
- **建议**：复用 ReadingPage 的尾部截断（保留 2KB）或流式阶段只显示纯文本进度；完整文本只在 `onDone` 后渲染。

### H-21 [P2] 纠错列表每项两个 SpeakButton，状态更新整页重渲染

- **位置**：`src/pages/CorrectPage.tsx:212-258`（每条纠错渲染两个 `SpeakButton`：`220`、`249`）；`src/components/SpeakButton.tsx:42-73`（每个实例独立 `useAudioPlayer`，含 2 个 state + effect）；`src/hooks/use-add-to-vocabulary.ts:45-65`（`addedWords`/`addingWords` 状态）。
- **机制**：30–50 条纠错 → 60–100 个 `useAudioPlayer` 实例。添加生词导致 `addedWords`/`addingWord` 更新 → CorrectPage 整页重渲染，全部纠错卡与 SpeakButton 重新协调。
- **触发条件**：纠错条目多的长文；点击“加入生词本”。
- **量级估算**：50 条纠错 → 100 个播放器实例，初始挂载成本 + 每次状态更新 100 个子组件重渲染。P2。
- **建议**：纠错卡 `memo` + 把“加入生词本”按钮抽成独立组件；行级 SpeakButton 可懒挂载（hover 时再创建）。

### H-22 [P2] ReviewPage 每次评分序列化整个 words 数组写 localStorage

- **位置**：`src/pages/ReviewPage.tsx:86-92`（`saveReviewSession` 内 `JSON.stringify(session)`）；`197-202`（开始复习时保存）；`325-330`（每评一个词保存 `words` + `results`）；`src/lib/db/review.ts:39`（`getReviewWords` 默认 limit=20）。
- **机制**：每评一个词都把整个 `words` 数组 JSON.stringify 后同步写 localStorage；默认 20 词规模小，但恢复会话逻辑最高可拉到 500 条（`src/pages/ReviewPage.tsx:70`），若未来放宽常规 limit，成本随 N² 增长，且 localStorage 写为同步主线程操作。
- **触发条件**：每次点击评分（again/hard/good/easy）。
- **量级估算**：20 词 × 每词约 300–800B ≈ 6–16KB/次，20 次共 <320KB，当前可忽略；500 词会到约 1.5MB/次 × 500 次。P2（当前轻微，防回归）。
- **建议**：localStorage 只存 `wordId` 列表 + `currentIndex` + `results`，恢复时按 id 重查；或写入节流到每次切词后一次。

---

## 已排除的疑似项（确认已优化 / 不成立）

1. **ReadingPage 流式期间不解析 markdown、不渲染 ResultCard**：`loading` 时 `sections` 返回 `EMPTY_SECTIONS`（`src/pages/ReadingPage.tsx:277-281`），仅 `StreamPreview` 渲染末尾 2000 字符（`57-68`、`399`）。确认优化到位。
2. **CorrectPage 完成前不解析 JSON**：`parsed` 依赖 `!loading`（`src/pages/CorrectPage.tsx:132-135`）；问题只在预览渲染（H-20）。
3. **KnowledgeGraph 不因父组件重渲染/主题/语言切换而重建**：实例 effect 仅依赖 `[data]`（`src/components/knowledge-graph/use-cytoscape-graph.ts:161-162`、`291`）；语言就地更新（`135-148`）；主题仅 `style().update()`（`293-315`）。无“每次渲染重建 Cytoscape”。
4. **折叠的 ResultCard 不挂载 children**：`src/components/ResultCard.tsx:103-105` 条件渲染，阅读页折叠维度/详情页图谱不会提前创建 ReactMarkdown/Cytoscape。
5. **Analytics 时间范围切换不会重新 JSON.parse**：`parsedAll` 只依赖 `[allRecords, resultById]`（`src/hooks/use-analytics/index.ts:177-180`），`parsedByType` 只做过滤（`184-196`）。仅剩 H-02 的重排序/聚合成本。
6. **ExercisePage 单题输入不会重渲染其他题卡**：`handleAnswer` 稳定 `useCallback` + `ExerciseCard` memo（`src/pages/ExercisePage.tsx:67-69`、`src/components/ExerciseCard.tsx:69-75`）。
7. **Speaking 录音没有每秒计时器/高频 setState**：`src/hooks/use-recording.ts:104-188` 只在 start/stop/auto-stop 改变 `recording`，页面每句更新来自用户动作，不是定时器。
8. **Vocabulary 搜索有 300ms 防抖且服务端过滤**：`src/pages/VocabularyPage.tsx:210-228`、`src/lib/db/words.ts:45-51`；不是每次按键立即 IPC（但清空搜索会立刻全量加载，见 H-14）。
9. **TextInput / MarkdownContent 已 memo**：`src/components/TextInput.tsx:50`、`src/components/MarkdownContent.tsx:16`，可隔断流式父级重渲染。
10. **Analytics 返回对象整体 memo**：`src/hooks/use-analytics/index.ts:268-336`，避免消费方因新对象引用导致下游 memo 失效。
11. **Dashboard/Analytics 查询均并行**：`src/pages/DashboardPage.tsx:149-172`；`src/lib/db/history.ts:184-190` 的 `Promise.all`。页面侧不存在串行瀑布（解析成本见 H-15/H-01）。

---

## 建议的测量方法

> 下列测量均建议在正式包/生产构建下进行；本次审查按要求未运行 build/test。

1. **CorrectPage 流式**：用 React DevTools Profiler 录制一次 2,000 词纠错流式（60s），记录 commit 次数与 `StreamPreview` 每次 commit 的渲染时长；同时用 Chrome Performance 面板统计长任务（>50ms）。对比 ReadingPage 同样长度文章的流式 commit。
2. **ReadingPage 朗读**：粘贴 3,000 词文章，点击朗读，录制 Performance；在每句切换处标记，统计 `Recalculate Style/Layout` 与 `OriginalText` 的 commit duration；用 `document.querySelectorAll('button').length` 记录 DOM 规模。
3. **Vocabulary 批量**：准备 100 个待补全单词与 500 行 CSV，分别记录总耗时、单次 `setProgress` 到 paint 的间隔、页面 commit 次数；用 `performance.measure` 包住 `enrichWord`/`addWord` 调用。
4. **Analytics**：构造 500 条历史（其中 150 条带大 result），测量“点击侧边栏 Analytics → 图表可见”的时间；对比首次与再次进入；用 Profiler 统计 `groupAndParseResults` 与首屏图表 commit 时长。
5. **Dashboard**：测量“导航回 / → 内容可见”的时间；在 `loadDashboard` 的 `await Promise.all` 前后打点，区分 IPC 等待与主线程解析时间。
6. **History**：加载 20 页（400 条）后删除一条，记录 refresh 的 IPC 载荷大小与列表 commit duration；用 Performance 面板观察 `toLocaleString` 的耗时占比。
7. **KnowledgeGraph**：在图谱上拖拽窗口大小/切换全屏，记录 ResizeObserver 回调次数与 `fit()` 耗时（可在 hook 内临时用 `performance.now()` 打点，不提交源码）。
8. **ReviewPage**：在 DevTools Performance 中单评分一次，测量 `localStorage.setItem` 的同步耗时；若未来调整 limit，重复 500 词场景。
9. **内存**：离开 ReadingPage（含图谱）后用 Chrome Memory 面板做 Heap Snapshot，间隔 1/5/10 分钟对比 DOM 节点数与 detached nodes，验证 TTL 之前的驻留成本。

---

## 附：与任务 B/C 的边界

- SQL 索引/查询计划、IPC 调用次数与 Rust 侧开销归 **02-data-backend**；本报告涉及 Dashboard/Analytics 查询的部分只计算**页面侧主线程解析与渲染**成本，不重复判断 IPC 是否并行（已在已排除项 11 确认并行）。
- SSE 逐 token 处理、TTS/ASR 服务内部实现归 **03-streaming-services**；本报告只从页面热路径角度记录流式 flush 对页面渲染的影响（H-20）以及口语录音停止时的 WAV 编码主线程成本（H-19）。
