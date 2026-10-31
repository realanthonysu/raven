# Raven 前端 React 渲染与 hooks 性能审查（性能分析 A）

> 审查对象：`D:\GitHub\raven`（Tauri v2 + React 19 + TypeScript 桌面应用）
> 审查方式：只读代码分析（read/grep/glob），未修改任何源码；按任务约定未运行 `npm build` / `npm test`。
> 审查范围：`src/components/**`、`src/hooks/**`、`src/contexts/**`（含外壳 `Layout`/`PersistentRoutes`、流式渲染路径、外部 store 与上下文）。页面文件仅在「hooks 的消费方/流式渲染范围」需要时引用，页面热路径的逐页深挖由性能分析 D 负责。
> 说明：任务描述中的 `use-goals` 在本仓库不存在独立文件，目标数据由 `src/contexts/GoalsContext.tsx` 的 `useGoals()` 提供；`ThemeProvider` 实际位于 `src/hooks/use-theme.tsx`（非 `src/contexts/`）。
> 证据约定：本报告的 `file:line` 均已按当前源码逐条核对；「量级估算」是基于代码结构的复杂度估算，不是实测值，测量方法见文末。

---

## 一、摘要

- **P0：0 项。** 未发现「有明确代码证据、且对常规用户必然造成可感知卡顿/内存增长/功能受阻」的渲染或 hooks 缺陷。流式 token 50ms 批量 flush、ReadingPage 解析延迟、MarkdownContent/TextInput/ExerciseCard 的 memo 化等关键优化确实已经落地（见 Info 项）。
- **P1：2 项。**
  - **P-01** ReadingPage 的原文区把输入文章渲染为「每个词一个 `<button>`」的完整列表，且按句高亮/编辑输入会触发整份词表重建，长文场景（数千词）可感知卡顿。
  - **P-02** 每次进入设置页，`LevelCard` 的 `useLevelEstimation()` 会无条件拉取 Analytics 级历史窗口（500 条元数据 + 150 条重型 result）并在主线程做 Zod 解析；浏览设置这一与历史无关的操作承担了分析页级别的数据成本，且该窗口无跨挂载缓存，Analytics 与 Settings 之间来回切换会反复付出成本。
- **P2：8 项**（P-03 ~ P-10）：级别切换重复解析全部 result、ResultCard 折叠卸载子树导致 Cytoscape/Markdown 重建、持久化路由壳的订阅扇出、练习页生成阶段的 20fps 空转重渲染、CorrectPage 流式预览渲染全文、Analytics 图表因局部 UI 状态整体重渲、VocabularyPage 100 张词卡搜索时全量重渲、App 级 Suspense 边界整壳替换。
- **Info：6 项**：已验证的既有优化与无需处理项（含 StrictMode 开发态说明）。
- **最值得 Lead 亲自复核的点**：
  1. P-01 的量化（用 2000/5000 词文章实测朗读切句与二次编辑的 long task）；
  2. P-02 的窗口设计是否应让 LevelCard 改用「最近 N 条」小窗口或缓存共享；
  3. 文末附录 A-01：Sidebar 的 `completedCount` 刷新门闩在计数回落/同槽位重复完成后不再触发刷新，属功能性缺陷（非渲染性能，但由 hooks 状态逻辑引起，建议一并修）。
- **流式提交范围结论**：`useLLMStreamPage` 每 50ms 最多一次 `setResult`（约 20fps），`ReadingPage` 在 `loading` 时返回 `EMPTY_SECTIONS` 并只渲染末尾 2000 字符预览，CorrectPage 的 parsed 解析也延迟到 `!loading`；真正随每次 flush 重渲的只是 `StreamPreview`（及页面函数体本身），这是当前实现中设计最正确的部分。练习页（Exercise/Listening/Speaking）反而在生成阶段因同一 `result` 状态每 50ms 重渲一次，但页面此时不消费 `result`，属可优化项（P-06）。

---

## 二、发现列表

### P-01（P1）ReadingPage 原文逐词 `<button>` 列表：长文按句高亮/编辑输入触发整份词表重建

**位置**
- `src/pages/ReadingPage.tsx:99-133`（`OriginalText` 组件：`sentences.map` → `sentence.split(/(\s+)/).map` → 每个词渲染一个 `<button>`）
- `src/pages/ReadingPage.tsx:355-359`（`<OriginalText sentences={originalSentences} currentSentenceIndex={currentSentenceIndex} onWordClick={handleWordClick} />`）
- `src/pages/ReadingPage.tsx:187-189`（`useReadAloud(input)`，朗读时 `currentSentenceIndex` 每句变化）
- `src/pages/ReadingPage.tsx:200`（`originalSentences = useMemo(() => splitSentences(input), [input])`）
- `src/hooks/use-read-aloud.ts:47-51`（逐句循环中 `setCurrentSentenceIndex(i)`）

**机制**
`OriginalText` 是 `memo` 组件（`src/pages/ReadingPage.tsx:99`），但其 props 中的 `currentSentenceIndex` 在朗读过程中每句都会变化，导致 memo 立即失效，于是**整篇文章的每个词按钮都会在每次切句时重新 render 并重新做一次 `split(/(\s+)/)`**。此外 `originalSentences` 依赖实时 `input`（`ReadingPage.tsx:200`），分析完成后再编辑上方 textarea（`TextInput` 的 `onChange={setInput}`，`ReadingPage.tsx:309-315`），每敲一个字都会重算全部分句并重建整棵词表。

**影响**
- 常规 500–1000 词文章：约 500–1000 个 `<button>`；长文 3000–5000 词：约 3000–5000 个按钮 + 等量事件处理器闭包。
- 朗读每句（约 3–6 秒一次）都会触发一次全量 reconcile；长文下可形成数十毫秒级的主线程任务（估算，需 DevTools 实测）；分析完成后编辑长文时，每个按键都会重复这一成本，表现为输入延迟。
- 同时是内存/GC 抖动来源：每次重建都会创建数千个 onClick 闭包。

**建议**
1. 把 `OriginalText` 拆成「按句 memo」：`SentenceRow = memo(...)`，只有 `currentSentenceIndex` 命中变化的前/后两句重渲；词按钮数量不变但更新范围从 N 句降到 2 句。
2. 高亮不要作为整棵列表的 prop：把 `currentSentenceIndex` 通过 CSS 变量/`data-active` 挂在容器上，或由 `SentenceRow` 自行订阅；避免整页状态驱动全词表。
3. `useReadAloud` 与 `originalSentences` 改用**提交时的输入快照**（例如 `submittedInputRef`，`ReadingPage.tsx:152` 已有类似 ref）而不是实时 `input`，既消除编辑时的重建，也顺带修复「分析后编辑文本会改变 Original 展示/朗读内容」的一致性问题（见附录 A-02）。
4. 词按钮改为 `span` + 容器级事件委托（点击时读取 `data-word`），把 DOM/闭包数量减半。

---

### P-02（P1）LevelCard 每次进入设置页都拉取 500 条历史元数据 + 150 条重型 result 并解析

**位置**
- `src/pages/settings/LevelCard.tsx:31-32`（`useLevelEstimation()` 在设置卡片挂载时即执行）
- `src/pages/SettingsPage.tsx:49`（`LevelCard` 无条件挂载）
- `src/hooks/use-level-estimation.ts:42-48`（`useHistoryWindow()` + `collectSkillEstimates(records, resultById, level)`）
- `src/hooks/use-history-window.ts:69-99`（挂载即 `getHistoryWithResults(...)`，无缓存、无共享）
- `src/lib/db/history.ts:129-130`（`HISTORY_RECORD_LIMIT = 500`、`HISTORY_RESULT_LIMIT = 150`）
- `src/lib/level-estimation-samples.ts:210-244`（`groupAndParseResults` 对每个 result 执行 `extractJsonSafe` + Zod）

**机制**
`useHistoryWindow` 是 Analytics 数据窗口的加载器，但 `LevelCard` 也在设置页使用它。于是用户只是打开「设置」查看主题/模型配置，也会触发：
1. 两条 IPC 查询：500 条轻量记录 + 最近 150 条重型 result；
2. 主线程 `groupAndParseResults`：最多 150 次 `extractJsonSafe`（含 `JSON.parse` + Zod `safeParse`，覆盖 correct/exercise/listening/speaking 四种 schema）。
该 hook 没有模块级缓存（对比 `lib/cache.ts` 的 `createCachedFetcher` 未用于历史窗口），Analytics → Settings → Analytics 的常见切换路径会重复同一份查询与解析。

**影响**
- 数据量级：重用户 150 条 result × 每条约 2–8KB ≈ 0.3–1.2MB JSON 的解析与校验（估算），加上 500 条记录的 IPC 反序列化；发生在设置页打开时，可能造成一次可感知的主线程占用与延迟。
- `LevelCard` 自己只显示 5 个技能徽章和少量建议，属于典型的「为小 UI 拉大窗口」。
- Settings 页还并行加载 ModelCard/VoiceCard/GoalCard 等配置，历史窗口会与其抢主线程/IPC。

**建议**
1. 给 `useLevelEstimation` 提供一个「最近 N 条」专用窗口（例如 100 条元数据 + 50 条 result），或直接复用 Dashboard 式的按需小窗口；估计引擎本来就有样本量上限与置信度语义。
2. 在 `lib/cache.ts` 之上给 `getHistoryWithResults` 增加按 `(recordTypes, limit, resultTypes, resultLimit)` 的短 TTL 缓存（参考 `buildPersonalizedContext` 的 60s TTL + `addHistory` 失效模式），让 Settings 与 Analytics 共享同一份窗口。
3. 若短期不改窗口：把 `LevelCard` 的被动估计改成折叠/按需加载（用户展开「被动估计」时再请求），避免打开设置页即触发。

---

### P-03（P2）`useLevelEstimation` 把 `level` 放进解析 memo 的依赖，切换级别时重复解析全部 result

**位置**
- `src/hooks/use-level-estimation.ts:45-48`（`useMemo(() => collectSkillEstimates(records, resultById, level), [records, resultById, level])`）
- `src/lib/level-estimation-samples.ts:257-263`（`collectSkillEstimates` 内部先 `groupAndParseResults`，再 `buildSkillEstimates`；`level` 只影响后者）

**机制**
`level` 只参与 `buildSkillEstimates` 的「建议生成」阶段，但被放在整个 `collectSkillEstimates` 的依赖里。用户在 `LevelCard`（`src/pages/settings/LevelCard.tsx:68-81`）逐个点选 A2/B1/B2 试级别时，每次点击都会重新执行 `groupAndParseResults` —— 即重新 `JSON.parse` + Zod 校验最多 150 条 result，而实际只需要重算 `buildSkillEstimates`。

**影响**
- 点击 3 次级别就多解析 450 条 result；在 P-02 的数据量下是一次几十毫秒级的主线程浪费（估算）。
- 与 P-02 叠加时放大明显，但与 P-02 的修复（小窗口/缓存）独立，仍值得拆开 memo。

**建议**
拆成两个 memo：
```ts
const parsed = useMemo(() => groupAndParseResults(records, resultById), [records, resultById]);
const { estimates, suggestions } = useMemo(() => buildSkillEstimates(parsed, level), [parsed, level]);
```
（`collectSkillEstimates` 可保留给无预解析的调用方。）

---

### P-04（P2）ResultCard 折叠即卸载子树：重新展开会重建 Cytoscape 实例并重跑 COSE 布局，Markdown 也会全量重解析

**位置**
- `src/components/ResultCard.tsx:103-106`（`{expanded && <CardContent>...}`，条件渲染而非 CSS 隐藏）
- `src/pages/ReadingPage.tsx:426-448`（知识图谱放在 `defaultExpanded={false}` 的 ResultCard 中）
- `src/components/knowledge-graph/use-cytoscape-graph.ts:162-261`（实例创建；`layout: { name: "cose", animate: false, ... }` 在 248-256 行，同步执行布局）
- `src/components/knowledge-graph/use-cytoscape-graph.ts:282-290`（卸载时 `cy.destroy()`）
- `src/pages/ReadingPage.tsx:402-410` + `src/components/MarkdownContent.tsx:16-18`（折叠后 `MarkdownContent` 被卸载，重新展开会重新走 `ReactMarkdown` 的 parse/sanitize/render）

**机制**
`ResultCard` 的折叠实现为条件渲染，折叠时直接卸载子树；对普通静态文本这是正确的省 DOM 策略，但对「包含有状态重量级实例」的子树（Cytoscape、ReactMarkdown 解析结果）意味着：
- 每次「展开 → 折叠 → 再展开」知识图谱，`useCytoscapeGraph` 的创建 effect 都会重新执行，COSE 布局在构造时同步跑一遍（`animate:false`，主线程阻塞）；
- 六维分析各节的 Markdown 在重新展开时重新解析全文。

**影响**
- 当前 prompt 约束图谱为 5–15 节点 / 10–30 条边（`src/prompts/reading.ts:103-105`），单次 COSE 布局估算约数十毫秒；若 LLM 返回更多节点（schema 无上限，`src/lib/schemas.ts:113-136`），耗时会线性/超线性增长。
- 长文六维分析每节 Markdown 可能数千字，重新解析有可感知延迟；发生频率取决于用户折叠/展开习惯。

**建议**
- 给 `ResultCard` 增加 `keepMounted`（或 `mountStrategy`）选项：知识图谱与长 Markdown 使用「首次展开后保持挂载 + CSS 隐藏」，普通短内容继续条件渲染。
- 或让 `KnowledgeGraph` 在 `ResultCard` 之外持有实例/缓存布局结果（把 `expanded` 只作为重算 viewport 的信号，而不是卸载信号）。

---

### P-05（P2）持久化路由壳的订阅/上下文扇出：任务状态变化与每次导航都会重渲两份常驻页面，interval 也被反复重建

**位置**
- `src/components/PersistentRoutes.tsx:126`（`const taskStatus = useTaskStatus();`）
- `src/components/PersistentRoutes.tsx:140-168`（30s TTL 检查 effect 的依赖为 `[pathname, taskStatus]`）
- `src/components/PersistentRoutes.tsx:194-205`（`TASK_KEYS.filter(...).map` 渲染所有已挂载页面，页面组件未 memo）
- `src/contexts/PageVisibilityContext.tsx:29-40`（`isPageHidden` 用 `useCallback([pathname])`；每次导航换新函数）
- `src/components/PersistentRoutes.tsx:187`（`PageVisibilityProvider` 包住两份常驻页面）
- `src/pages/CorrectPage.tsx:85`、`src/pages/ReadingPage.tsx:197`（`usePageHidden` 消费方）

**机制**
1. `PersistentRoutes` 自己订阅了整个任务状态对象（`useTaskStatus()` 返回整快照，`src/lib/task-status.ts:118-120`）。任何任务开始/完成/清除都会让它重渲，进而重渲两个常驻页面（CorrectPage、ReadingPage 没有 `memo`）。频率为每次任务 2–3 次，成本取决于隐藏页面的 DOM 规模。
2. 每次 `pathname` 变化都会产生新的 `isPageHidden` 函数，PageVisibilityContext 的 value 身份变化 → `usePageHidden` 的两个消费页面即使处于 `display:none` 也会重渲一次。
3. TTL interval effect 依赖 `taskStatus`，任务状态一变就 `clearInterval` + `setInterval`；`hiddenSinceRef` 中的时间戳仍在，所以不会丢计时，但会让「隐藏超时卸载」最多推迟一个 30s tick，且产生无谓的 timer 重建。

**影响**
- 导航频率下是每次导航一次（隐藏页）整页 render；任务完成时额外 1–2 次。ReadingPage 有数千词按钮的 DOM 时，虽然 `OriginalText`/`MarkdownContent` 的 memo 会挡住最重部分，但页面函数与 `visibleSections`/VocabularySection 仍会执行。
- 属于「低幅度、稳定存在」的渲染税，不是卡顿主因；适合与其它外壳优化一并处理。

**建议**
- `PersistentRoutes` 的 TTL 守卫改为在 interval 回调内直接读 store 快照（可在 `lib/task-status.ts` 暴露一个不触发订阅的 `getTaskStatusSnapshot()`，底层即 `store.getSnapshot`），或用一个由写入方维护的 `runningRef`，不订阅整个快照，从而避免任务状态驱动的页面重渲。
- `PageVisibilityProvider` 的 value 改为「按 slot 的稳定函数 + pathname 从 ref 读取」，或把 provider 下移到页面内部；至少让 `usePageHidden` 的返回值只在真正影响该页面时变化。
- 两份常驻页面组件用 `React.memo` 包裹（它们 props 为空，能挡掉父级无关重渲），并在文档中保留 `usePageHidden` 的订阅语义。

---

### P-06（P2）练习页生成阶段的 20fps 空转重渲染：`usePracticeSession` 内部 `result` 状态页面并不消费

**位置**
- `src/hooks/use-practice-session.ts:101-127`（内部调用 `useLLMStreamPage`，返回对象不含 `result`，见 `161` 行）
- `src/hooks/use-llm-stream-page.ts:168`（`const [result, setResult] = useState("")`）
- `src/hooks/use-llm-stream-page.ts:282`（`setResult((prev) => prev + chunk)`）
- `src/hooks/use-llm-stream-page.ts:334-339`（每 50ms 批量 flush）
- `src/pages/ExercisePage.tsx:207-238`、`src/pages/ListeningPage.tsx:233-269`、`src/pages/SpeakingPage.tsx:320-356`（生成阶段只渲染 loading/选择 UI，不展示 `result`）

**机制**
`usePracticeSession` 复用 `useLLMStreamPage`，后者的 `result` state 在流式期间每 50ms 更新一次；而 `usePracticeSession` 并不向外暴露 `result`，三个练习页在生成阶段看不到任何流式文本。每次 `setResult` 仍会让调用页组件重渲一次（React 没有「未消费 state 不触发渲染」的优化），按 30 秒生成估算约 600 次 commit。

**影响**
- 生成阶段 UI 很小（spinner + 按钮），单次 commit 成本低，但 20fps 的持续 commit 会占用主线程并干扰输入/动画帧；在低端设备或同时有 TTS/录音时更明显。
- 与 P-01 不同，这里没有用户可感知的「单次长任务」，属于持续的小额浪费。

**建议**
- 给 `useLLMStreamPage` 增加选项 `flushResult?: boolean`（默认 true）；`usePracticeSession` 传 `false`，只保留 `onToken` 缓冲/最终全文，不写 `result` state。
- 或把 `result` state 下沉到一个仅在页面需要展示流式文本时才挂载的子 hook；`usePracticeSession` 走独立通道。

---

### P-07（P2）CorrectPage 的流式预览每 50ms 渲染完整累积文本（ReadingPage 已做尾部截断）

**位置**
- `src/pages/CorrectPage.tsx:51-57`（`StreamPreview` 直接渲染完整 `text`）
- `src/pages/CorrectPage.tsx:276`（`{result && !parsed && <StreamPreview text={result} />}`）
- `src/hooks/use-llm-stream-page.ts:334-343`（50ms flush；`onDone` 时一次性 `setResult(fullText)`）
- 对照：`src/pages/ReadingPage.tsx:57-58,64-84`（只渲染 `result.slice(-2000)` 的末尾片段）

**机制**
CorrectPage 在 `parsed === null`（流式期间）渲染 `StreamPreview`，其 `text` 是不断增长的完整 JSON 字符串。每次 50ms flush 都会：
1. 将整个累积字符串作为 text node 更新；
2. 让 `StreamPreview` 的 props 变化，memo 失效（无法避免，但可限制渲染窗口）。

**影响**
- 典型写作纠错结果 3–10KB，20fps × 20s ≈ 400 次全文文本更新；对 WebView2 的文本节点更新成本随长度线性增长，通常可接受，但长文本（大段作文/多次重试）下会放大。
- 与 ReadingPage 的尾部窗口策略不一致，属于明显的「同类问题只修了一半」。

**建议**
复用 ReadingPage 的尾部截断策略（例如 `STREAM_PREVIEW_TAIL_CHARS = 2000`，按 UTF-16 代理对修正首字符），或流式期间只渲染「已接收 N 字符 + 省略提示」。

---

### P-08（P2）AnalyticsPage 局部 UI 状态（展开错题）导致全部 recharts 重渲；LevelProgressCard 派生数据未 memo

**位置**
- `src/pages/AnalyticsPage.tsx:136-139`（`days` 与 `wrongQuestionsShown` 两个页面级 state）
- `src/pages/AnalyticsPage.tsx:529`、`555-563`（错题列表按 `wrongQuestionsShown` 切片；按钮 `setWrongQuestionsShown((n) => n + 5)`）
- `src/pages/AnalyticsPage.tsx:306-415`（错误趋势、分布、三个 ScoreTrendChart）
- `src/pages/AnalyticsPage.tsx:99-123`（`ScoreTrendChart` 是普通函数组件，未 memo）
- `src/components/analytics/LevelProgressCard.tsx:104-113`（每次 render 重新 `new Map(estimates.map(...))` 并重建 `radarData`；`132-148` 的 RadarChart 未 memo）

**机制**
`wrongQuestionsShown` 是页面顶层 state，点一次「展开更多」会让整个 `AnalyticsPage` 函数重跑：`ScoreTrendChart`、错误分布 Bar/Pie、能力雷达、级别雷达全部以相同 props 重新 render。`useAnalytics` 的 `data` 对象本身已被整体 `useMemo`（`src/hooks/use-analytics/index.ts:268-336`），但其结果并没有把图表子树从父级重渲中隔离出来。`LevelProgressCard` 的派生 Map/数组也没有 `useMemo`，每次都重建。

**影响**
- recharts 的 `ResponsiveContainer`/图表在每次重渲都会重新计算布局与坐标轴（内部实现，需 profiler 确认具体耗时）；6 个图表叠加时，一次「展开更多」可能产生几十毫秒级主线程工作，表现为按钮响应迟滞。
- 与「切换时间范围」的重算不同，这里是纯粹的 UI 展开状态，不应触碰图表。

**建议**
- 将错题本抽成独立子组件，把 `wrongQuestionsShown` 下沉到该组件内部；
- 对 `ScoreTrendChart`、雷达图卡片加 `React.memo`（props 引用已稳定：`data.exerciseTrendData` 等来自 useMemo）；
- `LevelProgressCard` 的 `estimateBySkill`/`radarData` 用 `useMemo` 包一层。

---

### P-09（P2）VocabularyPage 默认 100 张词卡 × 11 个等级按钮 + SpeakButton；搜索框每个按键全列表重渲（页面级，与 task-4 交叉）

**位置**
- `src/pages/VocabularyPage.tsx:83`（`RENDER_PAGE_SIZE = 100`）、`123`（`visibleCount`）、`373`（`filtered.slice(0, visibleCount)`）
- `src/pages/VocabularyPage.tsx:486-489`（搜索 `value={search}`、`onChange={(e) => setSearch(e.target.value)}`）
- `src/pages/VocabularyPage.tsx:708-778`（`visibleWords.map((word) => <Card>...)`）
- `src/pages/VocabularyPage.tsx:764-774`（每张卡渲染 11 个等级按钮，`LEVELS` 来自 `WordLevelSchema.options`，见 `src/lib/schemas.ts:250-262`）
- `src/pages/VocabularyPage.tsx:715`（每张卡一个 `SpeakButton`，内部各自 `useAudioPlayer`）

**机制**
词表窗口为 100 条，每张卡约 13 个可交互元素（11 等级按钮 + 删除/补全 + SpeakButton）。搜索框是受控输入，每次按键 `setSearch` 都会让页面整体重渲；`filtered`/`visibleWords` 的 `useMemo` 虽然保住了数组引用，但 100 个 `<Card>` 组件不是 `memo`（词卡是内联 JSX），所以 100 张卡及其全部按钮都会重新执行 render。

**影响**
- 100 张卡 ≈ 1300+ 个 `<Button>` 元素 + 100 个 `SpeakButton`（各自持有 `useState`/`useEffect`）在每次搜索按键时重渲；在 500–5000 词库下可造成输入延迟（估算 10–40ms/键，需实测）。
- 「显示更多」每次 +100 张，成本线性增长；未使用虚拟滚动，但有 100 条窗口限流。

**建议**
- 抽出 `WordCard = memo(...)` 组件，所有传入回调（`handleDelete`/`handleSetLevel`）用 `useCallback` 固定身份；`handleEnrich` 已稳定（`VocabularyPage.tsx:262-284`）。
- 搜索框改用 `useDeferredValue(search)` 或把输入框状态与列表分离（列表按 deferred 值过滤），避免每次按键同步重渲 100 卡。
- 长期考虑 `@tanstack/react-virtual` 或继续降低 `RENDER_PAGE_SIZE`。

> 注：本项属于页面热路径，性能分析 D 的任务范围也覆盖 VocabularyPage；此处只记录与「组件树重渲/列表窗口」相关的事实，供交叉核对。

---

### P-10（P2）App 级 Suspense 边界覆盖整个 Layout：懒加载页面首次加载时整壳被全屏 fallback 替换

**位置**
- `src/App.tsx:86-112`（`<Suspense fallback={<div className="flex h-screen ...">加载中…</div>}>` 包住整个 `<Routes>`，其中包含 `<Route element={<Layout />}>`）

**机制**
所有页面都是 `React.lazy`（`src/App.tsx:11-20`），当导航到尚未加载的页面 chunk 时，最近的 Suspense 边界是包住整个 `Routes` 的这一层，因此 Layout（侧边栏 + 任务栏）会一起被卸载为「加载中…」全屏文本，直到 chunk 到达。PersistentRoutes 内部虽然有 per-page Suspense（`src/components/PersistentRoutes.tsx:200-202`），但只保护持久化页；其余路由页面都受 App 级边界影响。

**影响**
- 首次访问每个懒加载页面时会闪烁一次全屏 loading，侧边栏消失/重建；本地磁盘 chunk 通常快（几十毫秒级），但冷启动或杀毒扫描下会更明显。
- 不是卡顿，属于路由级加载体验问题；修复成本低。

**建议**
- 把 Suspense 下移到 `Layout` 的 `<Outlet />` 周围（保留 Layout 常驻），或给 `PersistentRoutes` 的 `<Outlet />` 加一个页面级 Suspense；App 级边界只作为兜底。

---

## 三、已排除的疑似项（核实后不成立 / 无需处理）

| 编号 | 疑似项 | 核实结论与证据 |
| --- | --- | --- |
| E-01 | KnowledgeGraph 每次父组件渲染都会重建 Cytoscape 实例 / 事件监听器累积 | **不成立。** 实例创建 effect 只依赖 `[data]`（`src/components/knowledge-graph/use-cytoscape-graph.ts:161-291`），`data` 来自 `useGraphData` 的 state（`src/hooks/use-graph-data.ts:23,68-69`），父级重渲不会换引用；回调经 `useLatestRef`（`use-cytoscape-graph.ts:104-109`）；卸载时 `cy.destroy()`（282-290），`MutationObserver`/`ResizeObserver` 均有 cleanup（118-127、331-340）。 |
| E-02 | 流式期间每 50ms 对全文重新 `parseSections` / ReactMarkdown 全量解析 | **不成立（ReadingPage）。** `sections` 在 `loading` 时强制取 `EMPTY_SECTIONS`，完整解析只在流结束后执行（`src/pages/ReadingPage.tsx:86-90,277-280`）；流式预览只渲染末尾 2000 字符（57-84、399）。CorrectPage 的 `parsed` 也延迟到 `!loading`（`src/pages/CorrectPage.tsx:132-135`）。MarkdownContent 为 `memo`（`src/components/MarkdownContent.tsx:16-18`）。 |
| E-03 | Context value 未 memo 导致全树重渲 | **不成立。** `GoalsContext` 的 value 经 `useMemo([goals, refreshGoals])`（`src/contexts/GoalsContext.tsx:71`），且 goals 有内容相等守卫（43-61）；`ThemeProvider` 的 value 与 `setTheme` 均 memo（`src/hooks/use-theme.tsx:78-89`）。PageVisibilityContext 的身份变化见 P-05，属有意设计的窄范围重渲。 |
| E-04 | 音频对象/AbortController 泄漏 | **hook 层未发现。** `useAudioPlayer` 卸载时按实例身份释放全局播放登记并在播放/加载中 abort（`src/hooks/use-audio-player.ts:122-131`）；`useAbortable` 卸载 abort（30-35）；`useRecording` 卸载停轨、清 timer、停 recorder（`src/hooks/use-recording.ts:81-102`）；`useReadAloud` 组合两者。实际 `Audio` 元素的 URL 回收在 `services/tts.ts`，由性能分析 C 复核。 |
| E-05 | `useEffect` 依赖错误导致重复请求/无限循环 | **未发现循环。** `use-retry-hint`（23-30）、`use-history-window`（69-99）、`use-stale-guard`、`use-phase-machine` 的 effect 依赖均稳定或显式使用 ref；`PersistentRoutes` 的 interval 重建是 P-05 的性能问题而非循环。 |
| E-06 | 列表 key 缺失/不稳定 | **未发现。** 组件层列表均使用业务键（`VocabularySection.tsx:60` 用 `entry.word`、`Sidebar.tsx:184` 用 `to`、`LevelProgressCard.tsx:196` 用 `kind-skill` 等）；ReadingPage/SpeakingPage/ListeningPage 的索引 key 用于静态不重排列表且有 biome 注释说明（`ReadingPage.tsx:112,120`、`SpeakingPage.tsx:521`、`ListeningPage.tsx:445`）。 |

---

## 四、Info：已验证的既有优化与说明

- **I-01 token 50ms 批量 flush 已落地。** `TOKEN_FLUSH_INTERVAL_MS = 50`（`src/hooks/use-llm-stream-page.ts:18`），`onToken` 只追加 `pendingTokensRef`，由单个 `setTimeout` 合并 flush（260-287、334-343）；`onDone` 丢弃缓冲并以 `fullText` 落地（341-343），避免尾包丢失。设计上把重渲染上限压到 ~20fps，符合注释与实现。
- **I-02 ReadingPage 的流式渲染策略已验证。** `loading` 时跳过 `parseSections` 与 Markdown 渲染，只渲染 2000 字符尾部预览（`src/pages/ReadingPage.tsx:57-84,277-280,399`），且 `OriginalText`/`TextInput` 均 memo（99、`src/components/TextInput.tsx:50`）。
- **I-03 叶组件 memo 化清单（已生效）。** `TextInput`（`src/components/TextInput.tsx:50-91`，注释明确说明流式 50ms flush 下的目的）、`ExerciseCard`（`src/components/ExerciseCard.tsx:69-186`，`handleAnswer` 在 `ExercisePage.tsx:67-69` 稳定）、`MarkdownContent`（`src/components/MarkdownContent.tsx:16-18`）、两个 `StreamPreview`（`CorrectPage.tsx:51`、`ReadingPage.tsx:64`）、`OriginalText`（`ReadingPage.tsx:99`）。
- **I-04 外部 store 订阅粒度。** `task-status` 与 `use-proficiency-level` 都返回整快照（`src/lib/task-status.ts:118-120`、`src/hooks/use-proficiency-level.ts:58-64`），没有 selector；但订阅者只有 Sidebar/TaskStatusBar/PersistentRoutes 等少数几处，且任务状态变更频率低（每次任务 2–3 次），当前规模无需引入 selector。`createExternalStore` 的 same-reference no-op 已避免同值通知（`src/lib/create-external-store.ts:47-53`）。
- **I-05 清理审计通过。** 定时器/监听器都有 cleanup：`use-retry-hint.ts:23-30`、`Sidebar.tsx:115-140`（含 2s debounce timer）、`PersistentRoutes.tsx:167`、`KnowledgeGraph.tsx:60-67` + `use-cytoscape-graph.ts:118-127,331-340`、`use-theme.tsx:74-76`、`use-recording.ts:81-102`、`use-audio-player.ts:122-131`、`use-add-to-vocabulary.ts:58-65`。
- **I-06 StrictMode（仅开发态）。** `src/main.tsx:8` 启用 `<React.StrictMode>`，开发态 effect 会双调用，导致 `App` 的 onboarding 检查与 `checkAndNotifyReview()`（`src/App.tsx:59-75`）、`GoalsProvider` 首次加载（`GoalsContext.tsx:66-68`）、`useHistoryWindow` 首次加载（`use-history-window.ts:69-99`）在 DevTools 中出现两次请求。生产构建不受影响；但 `checkAndNotifyReview` 的「先发送后写日期」在双击并发下理论上可在开发态重复发通知（生产单次），仅作为开发体验说明，不列为 P。

---

## 五、附录：审查过程中发现的可疑非性能问题（不在 P 编号内，建议 Lead 复核）

### A-01 `Sidebar` 的 completed 计数刷新门闩在计数回落/同槽位重复完成后不再触发刷新

- **位置：** `src/components/Sidebar.tsx:122-140`
- **机制：** `prevCompletedCountRef` 只在 `completedCount > prev` 时更新；当 `clearTaskCompleted()` 让计数下降（`Layout.tsx:75-79`），或同一任务槽从 `completed` 再次开始（`setTaskStatus(task, true)` 把该槽从 completed 变为 running，计数下降）时，effect 在 `completedCount <= prevCompletedCountRef.current` 处提前 return，`prev` 保持旧的高值。此后再完成一次任务，计数回到相同值时 `<=` 判断仍成立，不会刷新 streak/goals。由于 `Sidebar` 常驻挂载，这个门闩在整个应用会话内不会自行恢复。
- **影响：** 除第一次任务外的后续任务完成，Sidebar 的连续学习天数和今日目标进度可能不更新（直到用户导航触发 `fetchSidebarData` 的 pathname effect）。属功能性缺陷，不是渲染性能问题。
- **建议：** 记录「上一次已处理的 completed 任务集合」而非计数，或在 `completedCount` 下降时同步更新 `prevCompletedCountRef.current = completedCount`（两个方向都更新），并补一个「完成→清除→再完成」的单测。

### A-02 ReadingPage 的 "Original" 区使用实时 `input` 而非提交快照

- **位置：** `src/pages/ReadingPage.tsx:200`（`splitSentences(input)`）、`188-189`（`useReadAloud(input)`）、`355-359`、`405`（`VocabularySection sourceText={input}`）
- **机制：** 分析完成后用户编辑顶部 textarea，`input` 变化会改变原文展示、朗读文本和加入生词本的 sourceText，而历史记录/图谱基于 `submittedInputRef`（`ReadingPage.tsx:152,237`）的提交快照。展示与实际分析对象可能不一致。该问题与 P-01 的编辑重渲同源，建议一并改为读取提交快照。

---

## 六、建议的测量方法

1. **流式重渲染范围（DevTools React Profiler）**
   - 在 `/writing` 与 `/reading` 分别提交长文本（2000–5000 词），Profiler 记录一次完整流式过程；统计 commit 次数是否稳定在 ~20/s（对应 50ms flush），以及 commit 的「Render duration」集中在哪些组件（预期：CorrectPage 的 `StreamPreview` 文本节点；ReadingPage 的页面函数体 + `StreamPreview`）。
   - 在 `/reading` 分析完成后点击「朗读」，观察每次切句的 commit 是否只应渲染 ReadingPage 顶层 + `OriginalText`；对比 P-01 修复前后 `OriginalText` 的 render 次数与耗时。

2. **长文/大列表 long task（Chrome DevTools Performance + PerformanceObserver）**
   - `PerformanceObserver({ entryTypes: ["longtask"] })` 收集 >50ms 任务；场景矩阵：文章 500 / 2000 / 5000 词；词库 100 / 500 / 1000 词；历史窗口 100 / 500 / 150 result。
   - 重点测量：朗读切句、分析完成后编辑输入、VocabularyPage 搜索框连续输入、Settings 首次打开。

3. **Settings / Analytics 历史窗口成本**
   - 在 `useHistoryWindow` 的 `getHistoryWithResults` 前后打 `performance.mark/measure`（临时本地 instrumentation，审查阶段不改源码）；
   - 分别测量「Analytics 页加载」「Settings 页加载」「Analytics→Settings→Analytics」三次窗口的 IPC 往返 + `groupAndParseResults` 耗时；对比 `HISTORY_RESULT_LIMIT` 150 与 50 的差异。

4. **图表重渲染（Profiler）**
   - 在 AnalyticsPage 点击「展开更多」前后记录 Profiler commit，展开 recharts 子树（`BarChart`/`PieChart`/`LineChart`/两个 `RadarChart`）的 render 耗时；验证将错题本 state 下沉 + `memo` 前后差异。

5. **内存/DOM 观测**
   - 从 `/reading`（已生成知识图谱）导航到其它页并保持 10 分钟以上，DevTools Memory 快照对比 DOM 节点数、JS Heap、Cytoscape canvas 保留情况；确认 `HIDDEN_UNMOUNT_TTL_MS`（10 分钟）确实触发卸载，且期间无监听器增长。
   - 在 VocabularyPage 连续「显示更多」到 500 张卡，观察 DOM 节点数与输入延迟。

6. **StrictMode 开发态**
   - 仅需在开发构建中确认 `checkAndNotifyReview`、`GoalsProvider`、`useHistoryWindow` 的 effect 双调用是否可接受；生产包不受影响。
