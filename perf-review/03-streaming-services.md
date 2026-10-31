# 性能分析 C：流式 LLM/TTS/ASR 服务链与启动包体审查报告

- **项目**：Raven（Tauri v2 + React 19 + TypeScript + Rust/rusqlite）
- **审查范围**：`src/services/**`、`src-tauri/src/commands/{proxy,sse,ssrf}.rs`、`src-tauri/src/credentials.rs`、启动路径（`src/main.tsx`、`src/App.tsx`、`src/components/Layout.tsx`、`src/components/PersistentRoutes.tsx`、`Sidebar`/`GoalsContext`/`notifications`）、`vite.config.ts`、`index.html`、`package.json` 及现有 `dist/` 产物。
- **审查方式**：只读静态代码审查（read/grep/glob），未修改任何源码，**未运行构建/测试**（按要求避免与其他人抢资源）。
- **证据约定**：`file:line` 均为当前工作区实际行号，已逐条读源码核对；`dist/` 为工作区现有构建产物（`dist/index.html` 与最新源码均停在 2026-10-28 08:06 前后，见下），包体数字为实测文件大小，不是估算。
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
| P2 | 13 |
| Info | 1（另见“已排除的疑似项”与“已确认的优化”） |

**结论**：

1. **首屏包体存在一个构建配置级问题**：`vendor-charts` 分组通过 `includeDependenciesRecursively`（默认 true）把 recharts 的依赖 `clsx` 一并收进该组，而 `src/lib/utils.ts` 的 `cn()` 也依赖 `clsx`，最终导致 `button` 及入口 chunk 静态依赖整个 **424,550 B（gzip 118,209 B）的 recharts chunk**，`dist/index.html` 在**每个用户的每次冷启动**都 `modulepreload` 它，即使从未打开 Analytics（S-01）。这是本报告最值得优先修的一项。
2. **同一条首屏路径还带入了 zod**（共享 chunk 实测 103,300 B / gzip 30,651 B，S-02）和**整棵 OnboardingDialog 树**（S-03，入口 chunk 104,518 B / gzip 34,556 B 的一部分）；首屏 eager 载荷合计约 **972 KB raw / 285 KB gzip**（详见附录）。
3. **流式主链路整体设计是合理的**：Rust 侧按字节切行、跨块 UTF-8 安全；前端用 50 ms 批量 flush 避免每 token 一次 React 重渲染；TTS 返回原始 `tauri::ipc::Response` 而非 base64。主要剩余成本在**每 token 的分配/Channel IPC 事件数**（S-07）、**Done 再传一份完整全文**（S-08），以及**abort 只丢本地事件、Rust 生成继续跑满 120s**（S-06）。
4. **TTS/ASR 与批量旁路 LLM 的主要体验瓶颈不在单次请求，而在编排方式**：朗读逐句“合成完再播、播完再合成下一句”（S-12），批量补全严格串行且不把 `AbortSignal` 传给在途请求（S-17），ASR 的 WAV 编码与 base64 跨 IPC 在长录音时放大（S-15/S-16）。
5. 未发现会直接阻断功能的 P0；上述 P1 都有明确代码路径，但耗时/内存量级仍需按“建议测量方法”在目标机器上实测确认。

### 现有 dist 产物快照（用于包体结论）

| 文件 | raw bytes | gzip bytes | 是否首屏 |
| --- | ---: | ---: | --- |
| `index-Bi_sKVIx.js` | 104,518 | 34,556 | 是（入口） |
| `vendor-react-DFgfHP85.js` | 228,498 | 73,188 | 是 |
| `vendor-charts-H_zI5iTt.js` | 424,550 | 118,209 | **是（异常，见 S-01）** |
| `button-BzTEq-HL.js` | 40,161 | 13,606 | 是 |
| `error-utils-C5xvk-Gu.js`（含 zod） | 103,300 | 30,651 | 是（见 S-02） |
| `fetch-utils-BSAoM81O.js` | 3,020 | 约 1.3 K | 是 |
| 其余入口小 chunk（runtime/task-status/等） | 约 2,250 | 约 1 K | 是 |
| `index-Czy9loza.css` | 65,886 | 11,963 | 是 |
| **首屏合计** | **972,399** | **285,032** | — |
| `vendor-graph-CGd-uY3x.js` | 434,924 | 137,723 | 否（按需） |
| `vendor-markdown-BPQ9hrq0.js` | 120,075 | 36,609 | 否（按需） |
| `dist/` 全部文件 | 1,763,870 | — | — |

> 数据来源：`Get-ChildItem dist/assets` + GZip 压缩实测；dist 构建时间 2026-10-28 08:06，晚于最近一次 `src/**` 修改（08:05），可作为当前源码的产物参考。gzip 只用于比较体积，Tauri 打包内嵌资源通常不经过 HTTP gzip，首屏实际解析成本更接近 raw bytes。

---

## 一、启动与包体

### S-01 [P1] `vendor-charts` 被 `clsx` 拖成首屏静态依赖，recharts 424 KB 在每次冷启动加载

- **位置**：`vite.config.ts:37`（`includeDependenciesRecursively` 默认 true 的注释）、`vite.config.ts:40-63`（`codeSplitting.groups` 声明顺序：vendor-react priority 3，vendor-charts priority 2）；`package.json:25`（`clsx`）、`package.json:32`（`recharts`）；`src/lib/utils.ts:1`（`import { clsx } from "clsx"`）；`src/components/ui/button.tsx:4`（`import { cn } from "@/lib/utils"`）。
- **构建产物证据**：
  - `dist/index.html:10` 明确 `<link rel="modulepreload" ... href="/assets/vendor-charts-H_zI5iTt.js">`；
  - `dist/assets/button-BzTEq-HL.js:1` 的 import 头为 `import{v as r}from"./vendor-charts-H_zI5iTt.js"`；
  - `dist/assets/index-Bi_sKVIx.js:2` 也直接从 `./vendor-charts-H_zI5iTt.js` 导入；
  - 用 Node 加载 `vendor-charts-H_zI5iTt.js` 检查导出 `v`，其函数体为 `function E(){for(var e,t,n=0,r='',i=arguments.length;n<i;n++)...r+=t;return r}`，即 `clsx` 的 classnames 合并实现；该 chunk 同时包含 recharts 代码，文件体积 424,550 B。
- **机制**：`vendor-charts` 的 `test: /node_modules[\\/]recharts[\\/]/` 配合默认开启的 `includeDependenciesRecursively`，把 recharts 的依赖 `clsx` 收进 `vendor-charts` 组；而 `src/lib/utils.ts` 与 `button.tsx` 都依赖 `clsx`，Rollup 就生成 `button → vendor-charts` 的静态 import，入口再经 `button` 静态依赖该 chunk。**结果：AnalyticsPage 虽然通过 `React.lazy` 懒加载（`src/App.tsx:17`），但其 recharts 依赖在启动时就已被加载。**
- **触发条件**：每次应用冷启动 / 每次 WebView 重新加载。
- **影响与量级**：多加载并解析 **424,550 B raw（118,209 B gzip）** 的 recharts；占首屏 raw 的 43.7%、gzip 的 41.5%。按 V8 首次编译量级粗估（未实测）会增加数十到数百 ms 的启动时间，低配 Windows 机器、首次安装后杀毒扫描期间更明显；且这部分代码在首页并不执行。
- **建议**：
  1. 在 `codeSplitting.groups` 中把 `clsx`（以及 `tailwind-merge` 等通用工具）单独拆为更高优先级的小组，例如 `name: "vendor-utils", test: /node_modules[\\/](clsx|tailwind-merge)[\\/]/, priority: 4`，放在 `vendor-charts` 之前；
  2. 或对 `vendor-charts` 显式设置 `includeDependenciesRecursively: false`（只收 recharts 自身）；
  3. 重新构建后检查 `dist/index.html` 的 `modulepreload` 列表不再包含 `vendor-charts-H_*.js`，并用 DevTools Performance 对比首屏 Scripting/Compile 时间。
- **确认度**：机制和产物均确认（built chunk 的 import/export 已交叉验证）；耗时量级待实测。

### S-02 [P2] 首屏共享 chunk 含完整 zod 运行时（约 30.7 KB gzip）

- **位置**：`src/lib/db/settings.ts:13-15`（`extractJsonSafe` / `PlacementResultSchema` 模块级导入，用于 `getPlacementResult()`）；`src/lib/db/learning.ts:6`（`DailyActivitiesSchema`）、`src/lib/db/learning.ts:85`（`getSidebarData` 内 `DailyActivitiesSchema.safeParse`）；`src/lib/schemas.ts:9`（`import { z } from "zod"`）；`src/lib/parse-utils.ts:13-14`（`ZodType` 与 `CorrectionResultSchema`）。
- **构建产物证据**：`dist/index.html:13` 首屏 preload 了 `error-utils-C5xvk-Gu.js`（103,300 B / gzip 30,651 B）；对该文件做字符串检查可命中 `ZodError` / `zod`，说明 zod 运行时位于这个首屏共享 chunk。该 chunk 同时是 `error-utils` 的依赖，命名只是 chunk 名，不代表只含 error-utils。
- **机制**：`App.tsx:6` 从 `@/lib/db` barrel 导入 `getModels/getOnboardingDone`，`Sidebar.tsx:23` 导入 `getSidebarData`，`GoalsContext.tsx:29` 导入 `getLearningGoals`；这些 eager 模块中 `settings.ts`/`learning.ts` 在模块顶层 import zod schema，导致 zod 进入入口静态依赖图并被打进首屏共享 chunk。即使 Settings 页的 `getPlacementResult` 从未被调用，模块级 import 仍会求值。
- **触发条件**：每次启动（无论是否打开 Settings/是否使用 placement）。
- **影响与量级**：首屏多约 100 KB raw / 30.7 KB gzip 的解析与执行；zod v4 初始化与 schema 定义在主线程完成，估约十到数十 ms（未实测）。对首屏是纯负担。
- **建议**：
  - `getSidebarData` 的 `today_activities` 改为由 Rust 命令直接返回结构化字段（`HashMap<String, i64>` 或 typed DTO），删除 `learning.ts` 对 `DailyActivitiesSchema` 的依赖；
  - 把 `getPlacementResult`/`PlacementResultSchema` 拆到独立模块，仅在 Settings/Placement 流程中动态 `import()`；
  - 或给 zod 单独分组并评估是否可接受其进入首屏；目标是 `dist/index.html` 不再 preload 该 chunk。
- **确认度**：产物与模块依赖均确认；建议方案是结构性优化。

### S-03 [P2] `OnboardingDialog` 及其 6 个步骤组件静态进入入口 chunk

- **位置**：`src/App.tsx:4`（`import { OnboardingDialog } from "@/components/OnboardingDialog"`）、`src/App.tsx:114`（仅 `showOnboarding` 为 true 时渲染）；`src/components/OnboardingDialog.tsx:12-23`（静态导入 Dialog 和 `StepConfigureApi`/`StepConfigureVoice`/`StepFinish`/`StepPreview`/`StepSelectLevel`/`StepWelcome` 全部步骤及 `use-connection-test`）。
- **构建产物证据**：入口 `dist/assets/index-Bi_sKVIx.js`（104,518 B / gzip 34,556 B）字符串检查可命中 `欢迎使用`（`src/components/onboarding/StepWelcome.tsx:18` 的文案），证明 onboarding UI 已进入首屏 chunk。
- **机制**：`App` 顶层静态 import 使整个 onboarding 树（含 Dialog 基础组件、表单输入、连接测试逻辑、按钮/卡片 UI）在首屏执行模块求值；实际只在首次启动、且两个异步 DB 检查（`getModels`/`getOnboardingDone`）都返回空时才显示。
- **触发条件**：每次启动加载；首次启动才实际显示。
- **影响与量级**：入口 chunk 的解析/编译负担的一部分；静态导入还会继续拖入 `services/llm`/`services/tts` 等 onboarding 依赖（`OnboardingDialog.tsx:15` 的 `saveTTSSettings`，`StepConfigureApi` 的 `isLocalBaseUrl`），使首屏依赖图更大。具体占比未做逐模块 sourcemap 拆分，估计数十 KB raw。
- **建议**：把 `OnboardingDialog` 改为 `lazy(() => import(...))`，仅在 `showOnboarding === true` 时渲染并包一层局部 `Suspense`；同时把 onboarding 只需要的 `services/llm`/`services/tts` 导入隔离到该懒 chunk。
- **确认度**：入口 chunk 含 onboarding 文案已确认；具体模块字节占比待 sourcemap/分析器确认。

### S-04 [P2] 顶层 `Suspense` 包裹整个 `Routes`，懒加载路由未到时连 Sidebar/Layout 都不渲染

- **位置**：`src/App.tsx:82-116`（`<BrowserRouter><GoalsProvider><Suspense fallback=...><Routes>...`）；`src/App.tsx:86-91`（fallback 为全屏“加载中…”）；`src/App.tsx:95`（`<Route element={<Layout />}>`）；`src/components/Layout.tsx:134-145`（Sidebar 与 Outlet 在 Layout 内）。
- **机制**：所有路由页面均为 `lazy`（`src/App.tsx:11-20`），最近的 Suspense 边界位于 `Layout` 之外；因此首屏 Dashboard chunk 未到时，整个 `<Routes>`（含 Layout/Sidebar）被替换成全屏 fallback，而不是“侧边栏先出现、内容区 loading”。之后从任意懒路由导航到另一懒路由时也会再次整页 fallback（首次访问该 chunk 时）。
- **触发条件**：冷启动首次进入 `/`；首次导航到尚未加载的懒路由。
- **影响与量级**：本地 Tauri 资源加载通常很快（几十 ms），但会延后 Sidebar 首帧与用户可交互时间；在磁盘/杀毒慢的 Windows 上更明显。属于启动体验优化，不是功能问题。
- **建议**：把 `Suspense` 下移到 `Layout` 内部、仅包 `<Outlet />`（或每个路由元素外层），保证外壳/侧边栏先渲染；`PersistentRoutes` 内部的局部 Suspense（`src/components/PersistentRoutes.tsx:200`）可保留。
- **确认度**：结构确认；实际首帧差异需 Performance 截图验证。

### S-05 [P2] 启动首屏重复查询：review stats ×3、streak ×2、goals ×2；通知链内部串行

- **位置与链路**：
  - `src/App.tsx:59-67`：`Promise.all([getModels(), getOnboardingDone()])`，两条 IPC 并行；
  - `src/App.tsx:73-75`：`checkAndNotifyReview()` 启动；`src/services/notifications.ts:31-64` 内串行 `getNotificationEnabled()` → `getLastNotificationDate()` → `getReviewStats()` → 权限检查 → `setLastNotificationDate()`；
  - `src/contexts/GoalsContext.tsx:43-68`：挂载即 `getLearningGoals()`；
  - `src/components/Sidebar.tsx:87-117`：挂载与每次导航 `getSidebarData()`；`src/components/Sidebar.tsx:94` 明确忽略返回的 `goals`；
  - `src/lib/db/learning.ts:67-107`：`getSidebarData` 的 DTO 同时返回 `reviewStats/streak/goals/todayActivities`；
  - `src/pages/DashboardPage.tsx:149-172`：Dashboard 又并行发起 7 个查询（含 `getReviewStats`、`getLearningStreak`）。
  - Rust 侧：`src-tauri/src/repository/words.rs:184-202` 的 `get_review_stats` 是全表 `COUNT/SUM`；`src-tauri/src/repository/learning.rs:152-176` 的 `get_sidebar_data` 再做一次 review stats，并读取最多 365 天 streak、goals、today activities。
- **机制与结论**：App 的两个 effect（onboarding 检查、通知）与 GoalsProvider 在首帧就启动；Sidebar 要等 Layout 挂载（受 S-04 的 Suspense 影响）；Dashboard 在其 lazy chunk 到达后再并行发起 7 个查询。整体没有互相 await 的长串行瀑布（Dashboard 内部已 `Promise.all`，见页面报告 H-15），但存在重复数据读取：
  - review stats 在通知、Sidebar、Dashboard 各算一次（3 次全表统计）；
  - streak 在 Sidebar 与 Dashboard 各读一次；
  - goals 在 GoalsProvider 与 Sidebar 各读一次（而 `getSidebarData` 已返回 `goals`，只是 Sidebar 刻意忽略）。
  - 通知链自身是 3–4 次串行 IPC（`notifications.ts:34,38,43,57`）。
- **触发条件**：每次冷启动 + 首屏 Dashboard 加载；Sidebar 在每次路由变化还会按 2s 防抖重新执行 `getSidebarData`（`Sidebar.tsx:112-117`）。
- **影响与量级**：启动期约 14 次 `invoke`（App 2 + 通知 3 + Goals 1 + Sidebar 1 + Dashboard 7），其中重复的全表 `COUNT` 与 365 行 streak 查询随词库/打卡数据增长而放大；当前数据量下预计几十 ms 级（未实测），属于可合并的重复工作。
- **建议**：把 Sidebar 的 `getSidebarData` 结果通过一个轻量 context/共享缓存提供给 GoalsProvider（或让 `getSidebarData` 的 `goals` 成为唯一来源）；通知检查合并为单个 Rust 命令（返回值同时包含开关/日期/dueCount），或直接复用 Sidebar 的 review stats；Dashboard 复用启动期 sidebar 数据（短 TTL）。Sidebar 每次导航的聚合查询可改为按数据版本失效而非路径触发。
- **确认度**：调用次数与查询内容确认；实际耗时随数据规模变化，未实测。

---

## 二、LLM / SSE 流式链路

### S-06 [P1] Abort 只停止前端事件处理，Rust 侧生成继续跑满 120s（计费与资源浪费）

- **位置**：`src/services/llm.ts:246-273`（`proxyStreamChat` 的 abort 处理：`onAbort` 仅 `settled = true; resolve({ outcome: "unavailable" })`；注释明确“invoke 无法取消已发出的命令……Rust 侧请求会继续跑完成或超时”）；`src/services/llm.ts:275-295`（`channel.onmessage` 在 `settled` 后丢弃 token/done/error）；`src/services/llm.ts:297-312`（`invoke("stream_chat_completions", ...)` 无取消通道）；`src/hooks/use-stream-chat.ts:229-241`（abort 监听器只重置本地 loading/task-status）；`src-tauri/src/commands/sse.rs:188-193`（只有 `on_event.send` 返回 `Err` 才视为 `ChannelClosed` 并停止读取上游）；`src-tauri/src/commands/proxy.rs:287-333`（Rust 整体 `tokio::time::timeout` 默认 120s 后发 Error）。
- **机制**：Tauri `invoke` 没有取消语义；前端 abort 既不关闭 Channel，也不通知 Rust。Rust 的 `pump_sse_stream` 继续从上游读取 token 并逐条 `send`；前端 `channel.onmessage` 因 `settled` 直接 return，事件被静默丢弃。直到上游结束或 `run_stream` 的 120s 超时，Rust 才停止。
- **触发条件**：用户在长生成过程中点击停止、修改输入重新提交、切换页面触发 abort；尤其在“重新提交”时旧请求继续生成。
- **影响与量级**：对远程 LLM 意味着**最长 120s 的额外 token 生成与计费**（实际按上游速度），对本地 Ollama 意味着额外 CPU 推理；同时持续产生 Channel IPC 事件（前端丢弃但跨 IPC）。这是“取消”语义与成本的直接不一致，用户可感知为后台仍在跑、风扇/CPU 占用。
- **建议**：
  1. Rust 侧维护 request-id → `tokio_util::sync::CancellationToken` 注册表；新增 `cancel_stream(request_id)` 命令或在 `stream_chat_completions` 增加可取消句柄；`pump_sse_stream` 在 `select!` 中监听取消并 drop response，停止读上游；
  2. 前端在 `onAbort` 时调用取消命令（或让 `Channel` 的 JS callback 显式 `cleanupCallback()` 使 `send` 返回 Err，需验证 Tauri API 契约）；
  3. 在未实现真正取消前，至少缩短旧请求的 `timeoutMs`（重新提交场景传更短超时），并在 UI 提示旧请求仍在结束中。
- **确认度**：代码路径确认；额外计费/CPU 量级取决于供应商与生成长度。

### S-07 [P2] SSE 热路径每 token 多次分配 + 每条事件一次 Channel IPC，无批处理/背压

- **位置**：`src-tauri/src/commands/sse.rs:51-66`（`serde_json::from_str::<serde_json::Value>` 每 token；`content.to_string()` 再次分配；`full.push_str(content)`）；`src-tauri/src/commands/sse.rs:78-109`（每行 `buffer[start..i].to_vec()` 复制；`buffer.drain(..start)`）；`src-tauri/src/commands/sse.rs:176-201`（`dispatch` 每个 data 事件立刻 `on_event.send(ProxyEvent::Token { token })`，没有合并窗口）；`src/services/llm.ts:275-281`（每个 Channel event 执行一次 `fullText += token` 与 `callbacks.onToken`）；`src/hooks/use-llm-stream-page.ts:18`（React 侧 50ms flush）与 `:334-339`（onToken 只追加 buffer）。
- **机制**：一条 SSE data line 的处理成本 ≈ `to_vec`（字节复制）→ `String::from_utf8`（移动）→ `rest.to_string()`（再复制）→ `serde_json::Value` 全量解析（堆分配）→ `token.to_string()`（再分配）→ `ProxyEvent` JSON 序列化 → Tauri IPC 事件。即便单个 token 很小，**每个 token 一次 IPC message**，没有按网络 chunk 或时间窗口合并；前端 React 虽已按 50ms 批量 setState，但 IPC/JS handler 仍按 token 次数执行。
- **触发条件**：快速本地供应商（Ollama）或长输出；token 率越高、响应越长越明显。多数云端 API 每秒几十 token，影响较小。
- **影响与量级**：以 2,000 token 的响应计 = 2,000 次 Channel 事件与 2,000 次 JSON 解析/序列化；每次几十 µs 到几百 µs 时总计数十到数百 ms 的主线程/JS 事件处理（未实测）。`onToken` 只追加字符串，React 重渲染已被 50ms 缓冲限制，因此主要成本在 IPC 与分配，而非渲染。
- **建议**：Rust 侧按网络 chunk 或时间窗口（如 16–32ms）合并 token 后发送 `TokenBatch { text: String }`；用 typed `ChatChunk` 结构 + `serde` 反序列化替代 `Value`；line 切分避免逐行 `to_vec`（可用 `Bytes` 切片）；用基准测试固定 1 MB/10k token 输入的耗时上限。
- **确认度**：机制确认；实际 token 事件数与耗时需在目标供应商/机器上测量。

### S-08 [P2] `Done` 事件再传一份完整全文，流结束瞬间产生额外 IPC/内存峰值

- **位置**：`src-tauri/src/commands/sse.rs:196-199`（`on_event.send(ProxyEvent::Done { full_text: std::mem::take(full_text) })`）；`src-tauri/src/commands/sse.rs:286`（流结束无 `[DONE]` 时再次发送 `Done { full_text }`）；`src/services/llm.ts:260`（前端自行 `let fullText = ""`）、`:280`（每 token 累积）、`:282-286`（`event.fullText ?? fullText`）。
- **机制**：Rust 为了兜底或协议完整，在流结束时把已经逐 token 发送过的完整输出作为**一个** `full_text` 字符串再发一次；前端同时也在 `fullText` 中累积同一内容。对于 100 KB 的阅读分析结果，总 IPC 数据约为“100 KB 的 token 流 + 100 KB 的 Done JSON”，且完成瞬间要序列化/复制 100 KB 字符串；两端的全文副本在完成时同时存在。
- **触发条件**：所有 LLM 请求；输出越长越明显（阅读长文、写作长纠错 JSON）。
- **影响与量级**：额外一次 O(输出长度) 的 IPC 与内存拷贝；100 KB–1 MB 级输出对应 100 KB–1 MB 的额外传输/峰值。对于 20 Hz × 数秒的普通响应影响小，但长文分析完成瞬间可见一次约几十 ms 的主线程/IPC 负担。
- **建议**：`Done` 不再携带完整文本，改为让前端以自身累积的 `fullText` 为准（协议需协调测试）；或仅在“此前未收到任何 token”时携带全文；再或用 `Done { total_len, checksum }` 做一致性校验。前端 `proxyStreamChat` 也可在本地已累积时忽略 `event.fullText`。
- **确认度**：代码路径确认；峰值需按典型响应长度实测。

### S-09 [P2] SSE 行切分在“无换行长行”极端流下会反复重扫已积累 buffer（最坏 O(n²)）

- **位置**：`src-tauri/src/commands/sse.rs:78-109`（`extract_lines` 每次从 `start = 0` 扫描 `buffer`；找不到换行时保留全部残行）；`src-tauri/src/commands/sse.rs:218-227`（每个网络 chunk 都调用一次 `extract_lines`）；`MAX_SSE_BUFFER_BYTES = 32 * 1024 * 1024`（`:113`）只限制内存，不限制 CPU。
- **机制**：正常 SSE 每条事件都有换行/空行，残行很小，单次扫描 O(chunk) 可接受；但若上游在超时窗口内持续发送**不含换行的单条超长 data 行**（恶意端点或异常实现），每收到一个 chunk 都会从头重扫此前全部字节。按 8 KB chunk、32 MB 上限估算约 4,096 次扫描、平均 16 MB/次 → 约 65 GB 字节比较，足以长时间占满 CPU 后才触发大小限制。
- **触发条件**：仅恶意/异常 provider 或代理链；正常 OpenAI 兼容 SSE 不触发（已排除常规场景）。
- **影响与量级**：极端场景下命令线程 CPU 饱和、超时前无法处理其他请求；属于防御性健壮性/性能边界问题，非普通用户路径。
- **建议**：`extract_lines` 维护跨 chunk 的扫描起点（上次已扫描到的位置），只扫描新增字节；或对“未发现换行的残行”设置更小的软上限（如 1 MB）并快速失败；同时保留现有 32 MB 硬上限。
- **确认度**：机制可静态确认；实际触发需要恶意/异常流，正常场景无影响。

### S-10 [P2] `testLLMConnection` 的 `signal` 实际无效且无前端 deadline，重复测试会叠加在途请求

- **位置**：`src/services/llm.ts:532-545`（`testLLMConnection` 只在 `:538` 检查一次 `signal?.aborted`；`:541-545` 的 `invoke("test_llm_connection", ...)` 没有传 signal，也没有 `guardedInvoke`/前端超时）；`src/components/onboarding/use-connection-test.ts:32-53` 与 `src/pages/settings/ModelCard.tsx:164-190`（两者都 `abortTest()` + `getTestSignal()`，并依赖 `signal.aborted` 忽略过期结果）；`src-tauri/src/commands/proxy.rs:592-630`（Rust 默认 `timeout_ms.unwrap_or(120_000)`，不可取消）。
- **机制**：`useAbortable.abort()` 只中止本地 controller；`testLLMConnection` 已发出 `invoke`，Rust 端请求仍会跑到 120s 超时。连续点击“测试连接”会同时存在多条探测请求；端点黑洞时 UI 的 `testing` 状态最长持续 120s（`finally` 只在 `!signal.aborted` 时清理，旧请求被 abort 后不会复位，需依赖新请求）。
- **触发条件**：设置页/引导页测试连接；网络不可达、DNS 慢、供应商挂起时。
- **影响与量级**：每次测试最长 120s 的额外网络/连接资源；连续点击叠加请求；用户看到“测试中”长时间不结束。通常一次成功测试 <1s，影响集中在失败/离线场景。
- **建议**：像 TTS/ASR 一样用 `guardedInvoke({signal, timeoutMs: 15_000–30_000, ...})` 包一层前端等待边界；Rust 命令支持取消（同 S-06）；或至少对连接测试传更短的 timeout。
- **确认度**：代码路径确认；实际失败场景耗时取决于网络。

### S-11 [P2] 阅读提交先串行跑一次独立 LLM 语言检测，再开始六维分析

- **位置**：`src/pages/ReadingPage.tsx:214-238`（`handleAnalyze` 在 `await detectLanguage(input)` 成功后，才 `await handleSubmit(input)`；注释明确“串行执行”）；`src/hooks/use-language-detection.ts:31-41`（`detectLanguage` 内部 `streamChatAsync(buildPrompt(DETECT_PROMPT, text), model, signal)` 是一次完整 LLM 调用）；`src/pages/ReadingPage.tsx:174-177`（主分析的 `buildMessages` 还先 `await getProficiencyLevel()` 一次 IPC）。
- **机制**：每次点击 Start Reading：语言检测 LLM（0.5–3s）→ 读取 proficiency level IPC（约 ms）→ 六维分析流式请求；检测结果是进入分析的门槛，因此无法直接并行（若并行，非英文输入会白白发起分析）。但检测本身可以用本地启发式（ASCII 比例/Unicode 范围）先判断，LLM 仅兜底。
- **触发条件**：每次阅读分析提交。
- **影响与量级**：首 token 时间整体后移一次 LLM RTT，通常 0.5–3s；与文章长度无关。对于常用阅读功能是明显的固定延迟。
- **建议**：用本地纯函数快速判定“明显英文/明显非英文”；只有边界情况才调 LLM；或在用户输入/粘贴时预检测并缓存结果；`getProficiencyLevel` 可在页面挂载时预取。
- **确认度**：代码路径确认；与页面报告 `04-pages-hotpaths.md` 的 H-09 重叠，本报告补充了全链路成本视角。

---

## 三、TTS 链路

### S-12 [P1] 阅读朗读逐句串行：合成 → 播完 → 再合成下一句，句间停顿等于 TTS RTT

- **位置**：`src/hooks/use-read-aloud.ts:36-58`（`for (let i = 0; i < sentences.length; i++) { ... await play(sentences[i]); }`）；`src/services/tts.ts:258-273`（`speakText` 内部 `await getTTSConfigCached()` → `getTTSAudioUrl` → `playAudio`）；`src/hooks/use-audio-player.ts:142-200`（`play()` await `speakText`，即包含网络合成 + 播放结束才 resolve）；`src/services/tts.ts:137-153`（音频 URL 缓存只缓存已完成的音频，没有预取）。
- **机制**：`playAudio` 的 Promise 在 `audio.onended` 才 resolve（`tts.ts:227-230`），因此 `useReadAloud` 的下一句请求只能在**前一句播放结束之后**才发起；每句额外承担一次完整 TTS 合成 RTT。缓存只在重复朗读同一句时命中，第一次顺序朗读无法利用后续句的音频。
- **触发条件**：ReadingPage 点击朗读任意多句文章（`ReadingPage.tsx:187-189`）；文章越长越明显。
- **影响与量级**：按每句 TTS 合成 0.5–1.5s、20 句估算，整段朗读比“提前预取下一句”多出约 10–30s 的累计停顿（未实测）；用户会感到每句之间明显空白。这是朗读体验的主要延迟来源。
- **建议**：在 `services/tts.ts` 暴露 `prefetchTTS(text, config?)`（复用 `audioUrlCache.cached`）；`useReadAloud` 在开始播放第 i 句时预取 i+1（并发 1–2），下一句直接命中缓存后播放；首句可提前预取；播放结束到下一句开始只留下可忽略的调度时间。
- **确认度**：机制确认（`play` 等待 `onended`）；实际句间停顿取决于 TTS 供应商与网络。

### S-13 [P2] 每次 TTS 请求 Rust 侧重新读配置 + SSRF 校验重复做 DNS；首次请求前端/Rust 各读一次配置

- **位置**：`src/services/tts.ts:258-271`（`speakText` 先 `getTTSConfigCached()`，首次会 `invoke("db_get_tts_config")`）；`src-tauri/src/commands/proxy.rs:660-677`（`fetch_tts_audio` 每次 `load_tts_config`，再 `validate_proxy_url`）；`src-tauri/src/commands/proxy.rs:257-267`（`load_tts_config` 在 spawn_blocking 中读 SQLite + Keychain）；`src-tauri/src/commands/settings.rs:65-107`（`build_tts_config` 读 4 个 TTS settings + 1 个 dialect + Keychain）；`src-tauri/src/commands/ssrf.rs:114-134`（`validate_proxy_url` 对域名调 `resolve_and_judge_host`）；`src-tauri/src/lib.rs:151`（reqwest Client 使用 `GuardedDns`）；`src-tauri/src/commands/ssrf.rs:150-189`（`GuardedDns::resolve` 连接阶段再次 `getaddrinfo`）。
- **机制**：
  - 首次 TTS：前端为了拿 `speed`/缓存键读一次配置（DB + Keychain），随后 Rust `fetch_tts_audio` 又完整读一次配置（2 条 SQL + Keychain 缓存命中）；
  - 每次 TTS：Rust `validate_proxy_url` 都会对域名做一次 `getaddrinfo`（`spawn_blocking`），这是 SSRF DNS 重绑定防护的一部分；reqwest 建立新连接时 `GuardedDns` 还会做第二次（连接池复用连接时可避免第二次，但首次/重连会发生）。
- **触发条件**：每次朗读句子、每次 TTS 试听、每次 ASR（同配置路径）；朗读 N 句就是 N 次。
- **影响与量级**：单次 SQLite 查询 <1ms，Keychain 有 5min 进程内缓存（`credentials.rs:28,121-139`）；主要成本是 `getaddrinfo`，OS 缓存命中时约 1–10ms、冷解析 10–100ms。对 20 句朗读可能累计几十到数百 ms（未实测），并放大 S-12 的句间停顿。
- **建议**：Rust 侧缓存 `TtsConfig`（由 `db_set_tts_settings_batch` 递增版本/失效，或每次请求复用 `State`）；SSRF 校验缓存“已解析并验证过的 host→IP 集合”短 TTL（如 5min，并保留连接期 `GuardedDns` 复检），避免每句重复 `getaddrinfo`；前端可让 Rust 从服务端配置读 `speed`，减少首次重复配置读取。
- **确认度**：调用路径确认；DNS 实际延迟取决于环境。

### S-14 [P2] TTS 音频缓存只按 200 条上限，不按字节计费；旧配置版本条目不主动清理

- **位置**：`src/services/tts.ts:137-153`（`maxSize: 200`、`keyFn` = 版本戳|text|speed、`onEvict` = `URL.revokeObjectURL`）；`src-tauri/src/commands/proxy.rs:356`（`MAX_AUDIO_BYTES = 32 * 1024 * 1024`）与 `:804-810`（TTS 音频流上限 32MB）；`src/services/tts.ts:127-136`（注释承认按条数淘汰）。
- **机制**：每个缓存条目是一个 blob URL（内存中保留完整 mp3 字节）；只按最旧 200 条 FIFO 淘汰，没有总字节上限，也不在配置版本变化时主动清空旧版本条目——旧条目要等新请求把 FIFO 挤出去才 `revoke`。如果用户在小语速/长句场景连续朗读，200 条 × 每条约几十 KB–几百 KB，约 10–40 MB 常驻；理论上单条最大 32 MB，极端上限很高。
- **触发条件**：长时间使用朗读/听力、大量不同句子；切换 TTS 配置后继续使用。
- **影响与量级**：常驻内存随使用增长到上限才稳定；典型每音频 50 KB–200 KB 时约 10–40 MB，低内存机器/长会话可感知。
- **建议**：缓存改为按总字节 LRU（如上限 32–64 MB）并记录每个 blob 的 byte size；配置版本变化时调用 `audioUrlCache.invalidate()`（当前键结构已保证不命中，但可主动释放旧 blob）；或在空闲时清理。
- **确认度**：机制确认；实际内存取决于音频大小与使用量。

---

## 四、ASR 链路

### S-15 [P2] 停止录音后在 WebView 主线程逐样本做混音 + WAV 编码

- **位置**：`src/services/asr.ts:24-38`（`mixDownToMono` 对每个样本循环所有声道）；`src/services/asr.ts:45-85`（`audioBufferToWav` 的 `for (const sample of samples)` 逐样本 `Math.max/min` + `DataView.setInt16`，`:78-82`）；`src/services/asr.ts:105-114`（`convertToWav` 在 `AudioContext` 解码后同步编码）；调用入口 `src/pages/speaking/use-speaking-session.ts:142-161`；录音上限 `src/hooks/use-recording.ts:156-175`（60s 自动停止）。
- **机制**：MediaRecorder 的 webm/opus 不能直接给 mimo ASR，必须先 `decodeAudioData` 再重编码为 16-bit PCM WAV。`mixDownToMono` + `audioBufferToWav` 都是同步 JS 循环，在“停止录音”点击路径上阻塞 WebView 主线程；`AudioContext` 每次转换新建/关闭（`:106,112`，已正确关闭，不是泄漏，但构造/关闭也有成本）。
- **触发条件**：每次口语跟读停止录音（每句一次）。
- **影响与量级**：10s 录音约 44.1k/48k × 10 ≈ 44–48 万样本，两轮循环约 5–20ms；60s 上限约 260–290 万样本，约 30–100ms（与页面报告 H-19 的口径一致）；低端机可能更高，表现为停止后短暂掉帧/按钮不响应。
- **建议**：把 PCM 编码移到 Web Worker（AudioWorklet）或 Rust 侧；至少把 `for...of` 改为索引循环并预分配；`convertToWav` 对已是 `audio/wav` 的 Blob 直接返回。
- **确认度**：代码路径确认；耗时与设备/采样率相关，未实测。

### S-16 [P2] ASR 音频以 base64 data URL 跨 IPC，60s 录音会产生 7.7 MB 级字符串与多次拷贝

- **位置**：`src/services/asr.ts:119-129`（`FileReader.readAsDataURL(blob)` 生成 `data:audio/wav;base64,...`）；`src/services/asr.ts:147-172`（`transcribeAudio` 把 `audioDataUrl` 作为 `invoke("transcribe_audio", { audioDataUrl, ... })` 参数）；`src-tauri/src/commands/proxy.rs:567-576`（`asr_body` 把 `audio_data_url` 再 clone 进 `serde_json::Value`）；`src-tauri/src/commands/proxy.rs:857-898`（`transcribe_audio` 接收 `String`、`post_json` 序列化）；`src-tauri/src/commands/proxy.rs:370`（`MAX_AUDIO_DATA_URL_BYTES = 32MB`）。
- **机制**：WAV 为 16-bit 单声道 48kHz 时，60s ≈ 5.76 MB；base64 膨胀 4/3 ≈ 7.68 MB。路径中至少存在：`Blob → FileReader dataURL 字符串（7.7MB）→ Tauri IPC JSON 序列化/UTF-8 字节 → Rust `String`（7.7MB）→ `asr_body` 的 `Value` 克隆（7.7MB）→ reqwest JSON 请求体（7.7MB）` 的多个副本，峰值可能在几十 MB；主线程还要承担 data URL 生成。
- **触发条件**：ASR 录音越长越明显；典型 5–15s 句子约 0.6–2 MB data URL，尚可；接近 60s 上限时明显。
- **影响与量级**：60s 录音的 IPC/序列化与内存拷贝可能造成数十 ms 主线程/主进程开销和 20–30MB 峰值；如果同时有 LLM 流式任务，GC/内存压力叠加。属于特定长录音场景的 P2。
- **建议**：把 `transcribe_audio` 的音频参数改为二进制 IPC（Tauri v2 raw request body / `InvokeBody::Raw`，或先写临时文件再传路径），避免 JSON 字符串承载 base64；若短期必须保持 base64，至少在 Rust 侧对原始字节编码（不要在 WebView 用 FileReader 生成 data URL）；或让 Rust 直接接受 WAV 字节并在主进程编码。
- **确认度**：代码路径与体积换算确认；实际内存峰值需 DevTools Memory 验证。

---

## 五、批量/旁路 LLM 链路

### S-17 [P1] 词汇批量补全 / CSV 导入逐词串行 LLM，且没有把 AbortSignal 传给在途 enrichWord

- **位置**：`src/services/vocabulary-enrichment.ts:32-44`（`enrichWithModel` 每次一次 `streamChatAsync`）、`:83-96`（`enrichWord` 有 `signal` 参数并 `raceWithAbort(enrichWordCache.cached(...), signal)`）；`src/pages/vocabulary/batch-processor.ts:36-71`（`for` 循环逐条 `await processItem`，不并发）；`src/pages/vocabulary/use-batch-enrich.ts:54-66`（批量补全 `processItem` 内 `const enriched = await enrichWord(word.word)`，**未传 signal**）；`src/pages/vocabulary/use-vocabulary-import.ts:104-148`（CSV 导入逐行 `addWord`，缺释义再 `enrichWord`）。
- **机制**：缓存只避免同一单词/模型的重复请求（`vocabulary-enrichment.ts:63-69`，maxSize 200），但不同词必然各发一次完整 LLM 流式请求；`runBatch` 严格串行、没有并发池/速率控制；`isCancelled` 只在条目之间检查（`batch-processor.ts:48`），而批量补全调用 `enrichWord(word.word)`（`use-batch-enrich.ts:58`）没有传 signal，当前在途请求完全无法停止。注意：即使把 signal 传给 `enrichWord`，它内部的 `raceWithAbort`（`vocabulary-enrichment.ts:89`）也只会让**当前等待者**以 AbortError 返回，底层 `enrichWithModel` → `streamChatAsync(messages, model)`（`:38`）并没有接收 signal，共享 LLM 请求仍会继续跑完；要真正取消需要把 signal 下传到未缓存的底层请求或为缓存条目设计可取消请求。
- **触发条件**：点击“批量补全”且有大量缺字段词；CSV/TXT 导入几百行且无释义。
- **影响与量级**：N 个词 ×（1 次 LLM 往返，典型 1–10s）；100 词约 2–15 分钟，500 词可到数十分钟（与页面报告 H-10/H-11 的估算一致）。用户只能等待，期间页面还会因进度 setState 重渲染（页面报告的 H-12）。
- **建议**：并发池 2–4（结合供应商 rate limit）；把 `AbortSignal` 下传到 `enrichWithModel`/`streamChatAsync`（未缓存请求可取消），至少取消时停止调度后续条目并把当前条目标记为“已取消”而非“失败”；CSV 先批量插入（单事务）再批量 enrich；提供预计剩余时间/暂停按钮。服务层可新增批量 enrich API，避免每个词一次 IPC + 一次完整流式连接建立。
- **确认度**：机制确认（串行与 signal 未传均可在源码直接看到）；实际耗时随 LLM 响应变化。

### S-18 [Info] 阅读分析后的知识图谱固定串行两个旁路 LLM 请求（摘要 → 图谱）

- **位置**：`src/pages/ReadingPage.tsx:180-184`（`onDone` 中 `fetchGraph(submittedInputRef.current, historyId)`）；`src/hooks/use-graph-data.ts:39-55`（先 `streamChatAsync(GRAPH_SUMMARY_PROMPT, ...)`，再 `streamChatAsync(GRAPH_DATA_PROMPT, summary, ...)`）。
- **机制**：每次阅读分析完成后，后台自动发起两步 LLM；第二步依赖第一步摘要输出，无法并行；`streamChatAsync` 会完整接收流但丢弃 `onToken`（`services/llm.ts:477`）。它不阻塞分析结果展示（`onDone` 背景执行），但会占用 2 个 LLM RTT 的 token 配额与网络。
- **建议**：若图谱不是每次必需，改为用户点击“生成图谱”再触发；摘要结果可按文章 id 缓存复用；对长文章可先做更小的本地摘要/截断。当前设计是产品取舍，非缺陷，故 Info。

---

## 已排除的疑似项（读源码核实后不成立或无实际影响）

1. **“TTS 音频 base64 跨 IPC 很大”不成立**：TTS 正式路径 `fetch_tts_audio` 返回 `tauri::ipc::Response::new(audio)` 原始字节（`src-tauri/src/commands/proxy.rs:660-693`），前端 `invoke<ArrayBuffer>` 直接拿二进制；chat 模式的 base64 也已在 Rust 侧解码（`:815-851`）。真正使用 base64 跨 IPC 的是 ASR 输入，见 S-16。
2. **“每次请求新建 reqwest Client”不成立**：Client 在 `src-tauri/src/lib.rs:133-154` 的 setup 中创建一次并 `app.manage`，各命令通过 `State<'_, reqwest::Client>` 复用；`run_stream` 的 `client.inner().clone()` 是 Arc 克隆，非新建。
3. **“AbortSignal 监听器永久泄漏”基本不成立**：`withTimeout` 在 finally 中移除外部监听（`src/lib/fetch-utils.ts:98-125`）；`streamChat` 的 fallback 路径有 cleanup；`proxyStreamChat` 的 `signal` 监听器虽然正常完成时未显式移除，但每个请求的 signal 来自 `useAbortable` 的独立 controller，随请求结束被丢弃，不跨请求累积（`src/services/llm.ts:268-273`）。
4. **“AudioContext / blob URL 泄漏”不成立**：ASR `convertToWav` 在 finally `audioContext.close()`（`src/services/asr.ts:105-114`）；TTS 音频缓存 `onEvict` 调用 `URL.revokeObjectURL`（`src/services/tts.ts:137-153`），试听路径 `speakTestText` 在 finally revoke（`src/services/tts.ts:112-125`）。缓存本体的内存上限问题见 S-14。
5. **“主路径每 token 在主线程 JSON.parse”不成立**：主路径 token 在 Rust 侧解析（`src-tauri/src/commands/sse.rs:51-66`），TS 的 `readSSEStream` 只在代理不可用的 WebView 回退路径使用（`src/services/llm.ts:120-190`），且只对本地回环供应商有意义。
6. **“PersistentRoutes 启动就挂载 CorrectPage/ReadingPage”不成立**：页面只在首次命中持久化路径时加入 `mounted`，并通过 `React.lazy` + CSS display 切换（`src/components/PersistentRoutes.tsx:25-26,116-209`）；应用启动停在 Dashboard 时不会挂载这些页面树。
7. **“`useLLMStreamPage` 每 token 触发一次 React setState”不成立**：`onToken` 只追加 ref 缓冲，50ms 定时批量 `setResult`（`src/hooks/use-llm-stream-page.ts:18,260-287,332-343`）；这是本链路已做对的优化。
8. **“`get_models()` 会读 Keychain”不成立**：`db_get_models` 使用 `ModelRow`（`src-tauri/src/repository/models.rs:64-69` 的 `map_model_row`），列表不含真实 key；`get_model_api_key` 才是显式按需读取。
9. **“StrictMode 双调用影响生产”不成立**：`src/main.tsx:8` 的 StrictMode 只影响开发态 effect 双执行；生产构建不会双发启动请求。
10. **“TTS 相同文本重复合成”不成立**：`audioUrlCache` 以 `配置版本|text|speed` 做 Promise 去重（`src/services/tts.ts:137-153`），相同文本同配置只请求一次；不同配置版本/语速重新合成是预期行为。

## 已确认的优化（值得保留）

- **Rust 共享 reqwest Client + 连接池/TLS 会话复用**：`src-tauri/src/lib.rs:133-154`；避免每次 LLM/TTS/ASR 重新握手。
- **Keychain 进程内读缓存 5min**：`src-tauri/src/credentials.rs:28-39,121-139`；写/删路径立即回写（`:101-108,175-188,197-204,235-248`），热路径避免每次 10–100ms 的 Keychain 读。
- **SSE 跨块 UTF-8 安全切行 + 上限保护**：`src-tauri/src/commands/sse.rs:68-122,218-227`；正常场景下没有 UTF-8 损坏/无界内存。
- **前端 50ms token 批量 flush**：`src/hooks/use-llm-stream-page.ts:18,260-287,332-343`；避免每 token 重渲染。
- **TTS 原始字节返回 + blob URL 缓存/淘汰 revoke**：`src-tauri/src/commands/proxy.rs:660-693`、`src/services/tts.ts:137-153`。
- **ASR AudioContext 正确关闭、WAV 头/采样写入无共享状态**：`src/services/asr.ts:45-114`。
- **Sidebar 聚合命令（4 次 IPC → 1 次）**：`src-tauri/src/commands/learning.rs:76-87`、`src/lib/db/learning.ts:63-107`；设计方向正确（重复查询见 S-05）。
- **`vendor-graph`/`vendor-markdown` 确实懒加载**：`dist/index.html` 的 preload 列表不包含这两块，`vendor-graph` 434,924 B / `vendor-markdown` 120,075 B 只在对应路由首次访问时获取；问题只在 `vendor-charts`（S-01）。

## 建议的测量方法（按优先级）

1. **首屏包体/启动**：
   - 用 `vite build` 后检查 `dist/index.html` 的 `modulepreload` 列表（当前含 `vendor-charts`，见 S-01）；
   - DevTools Performance 录制“冷启动 → 首帧 Dashboard”：看 Scripting/Compile、`LoadingIndicator` 到 Sidebar 出现时间；
   - 用 `performance.getEntriesByType("resource")` 记录 Tauri 自定义协议资源加载量（按 raw bytes 统计）。
2. **SSE/LLM 流**：
   - 在 `src/services/llm.ts` 的 `channel.onmessage` 计数（token event 数、总字符数、首 token 时间、Done 时间），分别测云端与本地 Ollama；
   - 在 `src-tauri/src/commands/sse.rs` 的 `pump_sse_stream` 加 `tracing::debug_span!`，统计网络 chunk 数、data line 数、`on_event.send` 次数与耗时；
   - DevTools Performance 观察长文本流式期间的主线程 long task，对比 50ms flush 的开销。
3. **TTS**：
   - 在 `use-read-aloud.ts` 的循环内记录 `play()` 开始/结束时间，拆分“合成耗时”与“播放耗时”；对比预取前后句间 gap；
   - 统计 `fetch_tts_audio` invoke 耗时与缓存命中率；在 DevTools Memory 中统计 blob URL/ArrayBuffer 常驻数量。
4. **ASR**：
   - 用 `performance.now()` 包住 `convertToWav`/`blobToDataUrl`/`transcribeAudio`，分别测 5s、15s、60s 录音；
   - DevTools Memory 记录 IPC 前后峰值；在 Rust 端记录 `transcribe_audio` 请求体长度与构造/序列化时间。
5. **Rust 侧**：
   - 在 `validate_proxy_url`（`ssrf.rs:114-134`）和 `load_tts_config`（`proxy.rs:257-267`）加 tracing 计时，确认 DNS/Keychain/DB 的实际占比；
   - 观察 `run_stream` 的超时/取消路径（S-06）是否在 abort 后仍持续发送 Channel 事件。
6. **启动 IPC**：
   - 临时包装 `invoke` 或在 Rust 各命令入口打日志，统计冷启动 3s 内每命令调用次数；重点验证 S-05 的 review stats ×3 / streak ×2 / goals ×2。

## 附：与页面报告的交叉引用

- `perf-review/04-pages-hotpaths.md` 的 H-09（语言检测串行）、H-10/H-11（批量补全/导入串行）、H-19（ASR WAV 主线程）与本报 S-11/S-17/S-15 有重叠；本报告从服务链路角度补充了网络/IPC/内存与 signal 传递细节，Severity 保持与页面报告一致（H-09→P2、H-10/H-11→P1、H-19→P2）。
- 页面报告未覆盖的启动包体问题（S-01/S-02/S-03/S-04）与 TTS 句间网络停顿（S-12）是本报独有发现；建议 Lead 合并时以 S-01/S-12/S-06/S-17 为优先复核项。
