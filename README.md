# Raven

中文 | [English](./README_en.md)

AI 驱动的英语学习桌面助手

![version](https://img.shields.io/badge/version-v1.5.1-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![built with](https://img.shields.io/badge/built%20with-Tauri%202-orange)

AI 驱动的英语学习桌面助手。基于 Tauri v2 + React + TypeScript 构建。

## 功能

### 写作助手

粘贴英文文本，AI 自动进行语法纠错和写作建议。

- 错误识别与分类（主谓一致、时态、冠词、拼写等）
- 写作改进建议
- 一键复制修正文本或替换输入

### 阅读助手

粘贴英文文章，从六个维度进行深度阅读分析：

1. **参考翻译** — 完整中文翻译
2. **重点词汇** — 5-8 个核心词汇，含音标、搭配、例句
3. **句子拆解** — 复杂句式结构分析（最多 10 句）
4. **语法分析** — 语法要点提取（最多 10 项）
5. **背景与技巧** — 领域背景 + 翻译技巧
6. **延伸思考** — 批判性思维与开放性问题

另有交互式**知识图谱**（Cytoscape.js），支持中英文切换和全屏模式。

### 生词本

在阅读助手中点击单词或通过"添加到生词本"按钮保存词汇。支持难度标签（CET-4/6、TEM-4/8）。

### 间隔复习

翻卡界面 + 间隔重复算法：

- 正面：单词 + 音标；背面：释义、搭配、例句
- 自评："不认识"（重置为 1 天）、"模糊"（保持间隔）、"认识"（翻倍，上限 30 天）
- 连续 3 次"认识"自动升级为 `mastered`
- 智能调度 — 仅显示到期需复习的单词

### 历史与分析

- 所有分析保存至 SQLite，支持类型筛选（写作/阅读/练习）
- 详情页含可展开卡片和知识图谱
- 分析面板：错误类别分布、趋势图、会话摘要

### 弱项训练

基于写作批改数据自动识别薄弱环节，生成针对性练习题：

- 智能推荐 — 分析近 10 篇批改记录，自动识别高频错误类别
- 多样题型 — 填空题（时态/主谓一致/单复数）、改错题（冠词/介词）、重写题（用词/句式）
- 即时反馈 — 完成后统一对答案，展示正确答案和详细解析
- 历史追踪 — 练习结果持久化，可回看练习详情

### 后台任务

- 写作助手和阅读助手在页面切换时保持挂载
- 状态栏显示运行中/已完成任务
- 任务通知在用户返回页面前持续显示

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Tauri v2 |
| 前端 | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v3, lucide-react |
| LLM | OpenAI 兼容 API（可配置） |
| 图谱 | Cytoscape.js |
| 数据库 | SQLite (tauri-plugin-sql) |
| 图表 | recharts |
| 测试 | Vitest |
| 代码检查 | ESLint v10 |

## 下载与安装

### 系统要求

- Windows 10 及以上版本

### Windows 用户

从 [Releases](https://github.com/anthonysu/raven/releases) 页面下载最新版本：

- `Raven_1.5.1_x64-setup.exe` — 标准安装程序（推荐）
- `Raven_1.5.1_x64_en-US.msi` — MSI 安装包（适合企业部署）

下载后双击运行安装程序，按向导提示完成安装即可。

## 更新日志

### v1.5.1

质量加固版本——全面代码审查修复 + OnboardingDialog 重写：

- **6 个 CRITICAL 修复**：useStreamChat abort 竞态、缓存内存泄漏、SSE 流末尾 token 丢失、SpeedTrainer/ListeningPage 闭包陈旧
- **12 个 MAJOR 修复**：extractJson 花括号解析、SettingsPage 错误处理、VocabularyPage 性能优化、streamChat 超时机制、smartFetch 错误掩盖、Sidebar 无效查询等
- **9 个 MINOR 修复**：usePhaseMachine 稳定性、getReviewStats 空表安全、AnalyticsPage 排序/颜色、ErrorBanner 关闭按钮、ExerciseCard 无障碍属性
- **OnboardingDialog 重写**：用 shadcn/ui Dialog 组件替代手动 createPortal，内置 focus trap、scroll lock、ARIA 属性和动画

### v1.5.0

设计模式重构第二轮——引入可复用 hook、共享 UI 组件、集中式类型注册表，修复竞态条件，并完成代码审查修复：

- **`useAudioPlayer` Hook**：提取 TTS 播放的通用 hook，封装 AbortController 生命周期和 playing/loading 状态，SpeakButton 从 79 行精简至 42 行
- **`usePhaseMachine` Hook**：泛型阶段状态机，支持 `onEnter`/`onExit` 回调，ExercisePage/ListeningPage/ReviewPage 的阶段管理从散落的 `useState` 变为显式的状态转移
- **`createCachedFetcher` 工具**：泛型异步缓存，支持 Promise 去重 + FIFO 驱逐 + 手动失效，替代 db.ts 和 tts.ts 中的手写缓存逻辑
- **共享 UI 组件**：`EmptyState`、`ErrorBanner`、`LoadingIndicator` 三个语义化组件，4 个 LLM 页面统一使用
- **注册表模式**：`DETAIL_COMPONENTS` Map 替代 HistoryDetailPage 的 4 层三元链；`CATEGORY_EXERCISE_TYPE` 集中到 `type-config.tsx`
- **竞态修复**：SpeedTrainerPage 用 generation counter 替代 `stoppedRef` + 3 个 `setTimeout` hack
- **关键 bug 修复**：`playAudio` abort 时 Promise 永不 settle 的内存泄漏；`createCachedFetcher` 永久缓存失败请求导致无法重试；`fetchGraphData` 无法取消的竞态条件；`useStreamChat` options 依赖导致 execute 重复创建
- **注释补全**：为 10 个文件补充详细 JSDoc 和行内注释——SpeedTrainerPage（并发模式详解）、SettingsPage（handler + 表单字段）、ListeningPage（状态变量 + handler）、SpeakButton（三态逻辑）、tts.ts（playAudio Promise 生命周期）、db.ts（11 个 CRUD 函数）等
- **生词自动补全**：从阅读页面添加生词时，自动调用 LLM 补全音标、释义、搭配、例句；生词本新增"批量补全"按钮
- **新用户引导**：首次启动时弹出 4 步引导对话框（配置 API Key → 测试连接 → 功能预览 → 快速入门），支持 OpenAI/DeepSeek 预设
- **分析面板扩展**：覆盖所有学习类型——弱项训练得分趋势图、听力练习得分趋势图、8 个统计卡片、近期记录显示所有类型
- **学习 streak 与复习提醒**：侧边栏显示"连续学习 N 天"计数器和待复习词数 badge，新增 learning_streaks 表追踪每日活动
- **写作批改加入生词本**：每条纠错旁新增"加入生词本"按钮，自动 LLM 补全，三种视觉状态（添加/补全中/已添加）
- **Code Review 修复**：修复 ReadingPage addWord 失败 UI 卡死、CorrectPage notes 数据丢失、recordLearningActivity 竞态条件、批量补全卸载泄漏、新手引导误关闭等 9 个问题
- **模式合规修复**：SpeedTrainerPage AbortController 卸载清理、HistoryDetailPage/AnalyticsPage 统一使用 extractJson、共享组件替换内联 loading/empty 状态、fetch-utils 中文 JSDoc、ExerciseCard 接口文档
- **AI 个性化 prompt**：`buildPersonalizedContext()` 查询近期错误历史，提取高频错误类别和典型示例，注入写作批改和弱项训练 prompt
- **每日复习通知**：应用启动时检查待复习词数，通过浏览器 Notification API 发送系统通知，SettingsPage 添加开关
- **手动添加生词**：VocabularyPage 可折叠表单，支持 word/phonetic/definition/level 输入，空释义自动 LLM 补全
- **CSV 批量导入**：VocabularyPage 支持 CSV/TXT 文件导入，自动去重、补全缺失数据，显示进度和摘要
- **页面级测试**：38 个新测试覆盖 ExercisePage（11）、ReviewPage（12）、useStreamChat（15），共享 mock 工具，总计 103 个测试全部通过
- **听力闭环补全**：听力练习完成后可从错误句子中提取重点词汇，一键加入生词本并自动 LLM 补全
- **每日学习目标**：Sidebar 显示每日目标进度条（复习/练习/阅读/写作/听力），SettingsPage 支持目标设定和三种预设（轻松/标准/进阶）
- **学习画像雷达图**：AnalyticsPage 新增四维能力雷达图（语法/词汇/句式/细节），基于写作错误分析（70%）和练习得分（30%）计算，含趋势指标和强弱项总结
- **最终 Code Review 修复**：ListeningPage 重试阻塞、ReadingPage 语言检测无 AbortSignal、useStreamChat 状态闪烁、VocabularyPage 定时器泄漏、SpeedTrainer 语速闭包陈旧、CorrectPage addedWords 闭包问题、VocabularySection 错误处理、buildPersonalizedContext 查询优化

### v1.4.0

代码架构重构，引入设计模式消除技术债务：

- **`useStreamChat` Hook**：提取共享的 LLM 流式调用逻辑，封装模型查找、AbortController 生命周期和任务状态上报，4 个 LLM 页面各减少 ~40 行样板代码
- **`extractJson<T>()`**：统一 JSON 解析工具，三级回退策略（直接解析 → 代码块提取 → 括号匹配），替代了 5 处分散的内联实现
- **`smartFetch`**：提取 Tauri/WebView 双通道 fetch 策略为共享工具，消除 `llm.ts` 和 `tts.ts` 的重复代码
- **`addHistorySafe`**：统一历史记录写入的错误处理，修复 ReadingPage 的未捕获 Promise 拒绝
- **TTS 配置缓存**：SpeakButton 点击不再触发 4 条并行 SQL 查询，配置变更时自动失效缓存
- **`addModel` 事务保护**：模型插入 + 默认设置现在包裹在 BEGIN/COMMIT/ROLLBACK 中
- **组件提取**：ExerciseCard 和 VocabularySection 从页面中提取为共享组件，消除 HistoryDetailPage 的重复渲染逻辑
- **`parseSections` 归位**：从 llm.ts 迁移至 parse-utils.ts，职责归位
- 新增 13 个单元测试，总计 50 个测试用例全部通过

### v1.3.0

- **TTS 语音合成集成**：支持 OpenAI 兼容的 TTS API，可独立配置 API 地址、密钥、音色和语速
- **词汇发音**：生词本和复习页面每个单词旁添加发音按钮，点击即听
- **阅读朗读**：阅读助手分析完成后可逐句朗读原文，当前句子高亮同步
- **写作对比听**：写作批改结果中每条纠错的原文和修正均可分别播放，听觉对比更直观
- **听力练习**：全新功能，LLM 生成句子 → TTS 播放 → 用户听写 → 自动评分
- **语速训练器**：全新功能，粘贴英文文本后以五档语速（0.5x-1.5x）播放，支持单句/全文循环
- 设置页新增 TTS 配置卡片，含测试语音功能

### v1.2.1

- 弱项训练功能增强：支持按题型智能判分（填空题精确匹配，改错/重写题归一化匹配）
- 加载超时提示：LLM 响应超过 30 秒时显示"重新生成"按钮
- 保存失败反馈：练习结果写入数据库失败时显示警告横幅
- 任务状态栏集成：弱项训练任务现在会在顶部状态栏显示加载/完成状态
- 代码质量：全面补充注释，新增单元测试（32 个测试用例）

### v1.1.0

- 弱项训练：基于写作批改数据自动识别薄弱环节，生成针对性练习题
- 分析面板增强：新增弱项训练推荐，点击可直接进入练习
- 历史详情支持练习记录回看

## 项目结构

```
src/
├── components/          # 共享组件（知识图谱、布局、侧边栏、ExerciseCard、VocabularySection、page-states、OnboardingDialog 等）
├── hooks/               # 自定义 Hooks（useStreamChat、useAudioPlayer、usePhaseMachine）
├── test/                # 测试配置和共享 mock 工具
├── lib/                 # 工具库（数据库、解析、任务状态、类型配置、fetch 工具、缓存工具）
├── pages/               # 页面（写作、阅读、生词本、复习、历史、分析、设置、听力、语速训练）
├── services/            # LLM 流式服务、TTS 语音服务
├── test/                # Vitest 配置
└── types/               # TypeScript 类型定义

src-tauri/
├── src/lib.rs           # Tauri 插件注册
├── migrations/          # SQLite 数据库迁移（001-006）
├── capabilities/        # WebView 权限
└── tauri.conf.json      # 应用配置
```

## 许可证

MIT © Anthony Su
