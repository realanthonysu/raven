# Raven

中文 | [English](./README_en.md)

![version](https://img.shields.io/badge/version-v1.9.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![built with](https://img.shields.io/badge/built%20with-Tauri%202-orange)

**AI 驱动的英语学习桌面助手** — 围绕听、说、读、写四项核心能力设计，基于 Tauri v2 + React + TypeScript 构建。

支持配置两类模型：**文本模型**（LLM，驱动所有分析和生成）和**语音模型**（TTS 语音合成 + ASR 语音识别），打通从输入到输出的完整学习闭环。

## 目录

- [功能](#功能)
- [安全](#安全)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [开发命令](#开发命令)
- [项目结构](#项目结构)
- [测试](#测试)
- [更新日志](#更新日志)
- [许可证](#许可证)

## 功能

### 仪表盘

应用首页，提供主动式学习引导：

- 待复习词汇摘要（待学习/学习中/已掌握）
- 弱项分析（基于近期写作的高频错误类别）
- 快速入口（写作/阅读/听力/口语训练/词汇复习）
- 近期学习时间线

### 水平定级与循序渐进

以 CEFR（A2 / B1 / B1+ / B2 / B2+ / C1）为内部尺子、中国考试体系为显示锚点（中考 / 高考 / 大学四级 / 六级 / 专业四级 / 专业八级 / 雅思托福），为所有训练提供统一的难度标准：

- **定级** — 首次引导中自报水平，设置页「英语水平定级」随时可改；级别选择即生效，历史记录保留生成时的级别
- **AI 定级测试** — 12 道递增难度单选题（覆盖六档、每档 2 题），完成后本地规则计分（低档到高档累计正确率达到 60% 即认定该档达标），给出估计级别与各档正确率，可一键应用为当前级别
- **难度坡度** — 写作纠错、阅读精读、弱项训练的提示词按级别注入词汇范围、句长、语法点与篇幅规格；口语/听力的难度选项由当前级别派生（低一档 / 标准 / 挑战）
- **写作估级** — 每次批改附写作估级（如 B2）与一句判断依据，历史详情同样展示
- **被动估计** — 从真实练习数据确定性估计写作/阅读/练习/听力/口语五项技能级别（新样本权重更高、得分相对基准分调档），标注置信度与样本量；估计仅作建议，需手动应用，不会自动改级
- **词汇分级** — 生词本按 11 档考试等级自动标注，并统计各级掌握度

### 写作训练

粘贴英文文本，AI 自动进行语法纠错和写作建议。

- 错误识别与分类（主谓一致、时态、冠词、拼写等）
- 写作改进建议
- 一键复制修正文本或替换输入
- 纠错结果可一键加入生词本，自动 LLM 补全
- 按当前水平级别调整纠错基准与建议重点，并给出本次写作的估级与判断依据

### 阅读训练

粘贴英文文章，从六个维度进行深度阅读分析：

1. **参考翻译** — 完整中文翻译
2. **重点词汇** — 5-8 个核心词汇，含音标、搭配、例句
3. **句子拆解** — 复杂句式结构分析（最多 10 句）
4. **语法分析** — 语法要点提取（最多 10 项）
5. **背景与技巧** — 领域背景 + 翻译技巧
6. **延伸思考** — 批判性思维与开放性问题

按当前水平级别调整词汇讲解的生僻度、长难句选取与语法讲解深度。

另有交互式**知识图谱**（Cytoscape.js），支持中英文切换和全屏模式。分析完成后可点击"新文章"按钮重置状态，开始新的精读。

### 口语训练

跟读模仿句子，录音后 AI 评分纠错：

- LLM 生成句子 — 难度由当前水平级别派生（低一档 / 标准 / 挑战），可自由切换；主题含日常对话、商务英语、旅游出行、科技、校园生活、面试自我介绍
- 录音跟读 — 逐句录音，ASR 语音识别转写
- AI 评分 — LLM 对比原文和转写结果，从准确度、流利度、发音三维度评分，给出改进建议

### 听力训练

TTS 播放句子，用户听写，AI 自动评分：

- LLM 生成句子 — 难度默认跟随当前水平级别，可切换低一档 / 标准 / 挑战；主题可选
- TTS 语音播放 — 支持多种音色和语速
- 听写输入 — 用户听后输入听到的内容
- 自动评分 — 对比原文和听写结果，精确到单词级别打分
- 错句词汇提取 — 从错误句子中提取重点词汇，一键加入生词本

### 生词本

在阅读/写作/听力助手中点击单词或通过"添加到生词本"按钮保存词汇。支持考试体系等级标签（小学 / 中考 / 高考 / CET-4 / CET-6 / 考研 / TEM-4 / TEM-8 / 雅思 / 托福 / 超纲），补全时由 LLM 自动标注，也可手动修改；自动标注不会覆盖手动标记。

- 手动添加词汇（自动 LLM 补全音标、释义、搭配、例句）
- CSV/TXT 批量导入（支持 RFC 4180 引号字段、自动去重、自动补全）
- 导出为 CSV 或 Anki 导入格式（Tab 分隔）
- 单个/批量补全缺失数据
- 分级掌握度统计 — 按等级展示词数与新词/学习中/已掌握分布

### 间隔复习

翻卡界面 + FSRS（Free Spaced Repetition Scheduler）间隔重复算法：

- 正面：单词 + 音标；背面：释义、搭配、例句
- 四档自评："不认识"、"模糊"、"认识"、"简单"（对应 FSRS 的 Again/Hard/Good/Easy 评分）
- 复习次数达标后自动升级为 `mastered`（"简单"可快速晋升）
- FSRS 算法根据记忆稳定性和难度动态计算复习间隔
- 仅显示到期需复习的单词

### 弱项训练

基于写作批改数据自动识别薄弱环节，生成针对性练习题：

- 智能推荐 — 分析近 10 篇批改记录，自动识别高频错误类别
- 多样题型 — 填空题（时态/主谓一致/单复数）、改错题（冠词/介词）、重写题（用词/句式）
- 即时反馈 — 完成后统一对答案，展示正确答案和详细解析
- 按级别命制 — 题干词汇与语法考点按当前水平级别生成
- 历史追踪 — 练习结果持久化，可回看练习详情

### 历史与分析

- 所有学习记录保存至 SQLite，支持类型筛选（写作/阅读/口语/听力/练习）
- 分页加载（每次 20 条），详情页含可展开卡片和知识图谱
- 分析面板：错误类别分布、趋势图、得分趋势、学习画像雷达图、弱项推荐、**分技能级别雷达**（含置信度、样本量、均分与升级建议）

### 其他特性

- **新用户引导** — 首次启动 6 步引导对话框：欢迎 → 配置 MiMo 文本 API（含连接测试）→ 选择英语水平 → 配置语音（TTS/ASR）→ 功能预览 → 完成
- **每日复习通知** — 应用启动时检查待复习词数，通过 Tauri 原生通知插件（tauri-plugin-notification）发送系统通知
- **学习 streak** — 侧边栏显示连续学习天数和待复习词数 badge
- **每日学习目标** — 侧边栏显示每日目标进度条（复习/弱项练习/阅读/写作/听力/口语）
- **后台任务** — 写作助手和阅读助手在页面切换时保持挂载，状态栏显示任务状态
- **数据管理** — CSV/Anki 导出与数据库备份走原生保存对话框（位置任选），备份亦可一键写入 Documents/Raven 默认位置；支持从备份文件恢复数据库（恢复前自动快照，恢复后自动刷新应用内存状态）
- **系统托盘** — 关闭窗口时最小化到托盘而非退出；左键单击托盘图标恢复窗口
- **复习队列持久化** — ReviewPage 当前复习队列写入 localStorage，意外中断后可恢复
- **分析时间范围筛选** — AnalyticsPage 支持 7/30/90 天/全部时间范围切换
- **结构化错误** — 后端 `AppError` 携带 `category`（database/validation/credential/network/export/io）和 `message` 字段，前端可按类别分支处理

## 安全

### API Key 存储

API Key 不再以明文或 Base64 存储在 SQLite 中，而是写入 **OS Keychain**（通过 `keyring` crate）：

- Windows: Credential Manager
- macOS: Keychain
- Linux: Secret Service（GNOME Keyring / KWallet）

每个模型配置的 API Key 以 `model_{id}` 为账户名存储在 `raven` 服务下；TTS API Key 以 `tts` 为账户名存储。即使数据库文件泄露，也无法获取 API Key。

出于最小暴露面考虑，模型列表查询接口（`get_models`）不返回 API Key；编辑单个模型时通过 `get_model_api_key` 按需从 Keychain 读取并预填，支持明文/密文切换显示。

### HTTP 权限与 LLM 请求代理

- **LLM 请求经 Rust 侧代理**（`commands/proxy.rs`）— 使用 `reqwest` 发起 SSE 流式请求，API Key 从 OS Keychain 读取、不下发 WebView；token 经 Tauri Channel 推回，业务错误（超时/网络/API 4xx 5xx）同样经 Channel 传达，命令返回 `Ok` 避免与 invoke reject 竞态
- **TTS/ASR 请求经 Rust 侧代理且服务端自读配置**（`commands/proxy.rs`）— 正式 TTS/ASR 请求（`fetch_tts_audio` / `transcribe_audio`）的配置（base_url/model/voice）与密钥均由代理命令服务端自读（DB settings 表 + OS Keychain），前端不再传 base_url；TTS 试听命令 `test_tts_audio` 接受前端传入未保存的 base_url 与表单新输入的 Key（经私网段 SSRF 校验），用于设置页验证新配置
- **密钥下发的显式豁免清单** — 以下三处命令刻意向前端返回明文 Key（登记于 `commands/proxy.rs` 模块文档）：`get_model_api_key`（编辑表单预填已存 Key）、`db_get_tts_config`（设置表单预填 Key，仅用于表单展示与 TTS 试听路径——试听可传表单新输入 Key 或由服务端从 Keychain 自读）、`db_get_default_model`（默认模型查询回填 Key：WebView 降级请求路径需组装 Authorization 头，前端亦以 Key 非空作为已配置判据）；新增返回密钥的命令必须在该清单登记
- **WebView 侧 HTTP 仅限本地回环**（`capabilities/default.json`：`http://127.0.0.1` / `http://localhost`）— 前端不再直连任意 HTTPS 端点（LLM/TTS/ASR 与连接测试均已迁移至 Rust 代理），仅保留代理不可用时的降级路径与本地回环能力，防止 SSRF 访问内网 HTTP 服务（路由器、云 metadata 服务等），同时保留 Ollama 等本地部署能力

### 导出净化

- **CSV 导出** — 对用户可控字段进行公式注入防御：以 `=` `+` `-` `@` 开头的单元格会被前缀单引号 `'`，防止 Excel/LibreOffice 将其解释为公式执行
- **Anki 导出** — 转义 HTML 特殊字符（`&` `<` `>`），防止 Anki 卡片渲染异常或 XSS；替换 Tab/换行符防止字段错位

### 数据库完整性

- `PRAGMA foreign_keys=ON` 在连接初始化时启用外键约束
- 模型新增采用"先提交 DB 事务、再写 Keychain"策略：若 Keychain 写入失败，删除刚插入的 DB 行作为补偿，避免留下无 Key 的孤儿记录；模型更新的存在性检查与更新语句包进同一 `BEGIN IMMEDIATE` 事务（防并发竞态），提交后写 Keychain 失败会返回错误提示重新编辑
- SQLite 错误经 `From<rusqlite::Error>` 转换时脱敏：完整错误仅写入主进程日志，前端只收到不含 SQL 片段/表名的通用消息
- 备份目标文件以原子创建（`create_new`）写入，目标已存在即报错（消除 exists 检查与创建之间的 TOCTOU 窗口），防止覆盖已有文件造成数据丢失
- 后端枚举字段（`review_status` / `record_type` / `goal_type`）入库前校验合法值，防止前端传入非法枚举破坏查询语义
- settings 表键名读写均经统一白名单校验（`db_get_setting` / `db_set_setting`），防止前端读写任意键值对

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Tauri v2 |
| 前端 | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v4, lucide-react |
| 文本模型 | **MiMo**（推荐，OpenAI 兼容）/ OpenAI / DeepSeek / Ollama |
| 语音模型 | **MiMo TTS/ASR**（mimo-v2.5-tts / mimo-v2.5-asr，推荐）或 OpenAI 兼容语音 API |
| 图谱 | Cytoscape.js |
| 数据库 | SQLite（rusqlite + r2d2 连接池，WAL 模式） |
| 凭据存储 | OS Keychain（`keyring` crate） |
| 结构化日志 | `tracing` + `tracing-subscriber`（env-filter） |
| Schema 校验 | Zod v4（LLM JSON 响应运行时校验） |
| 错误处理 | `AppError` 结构化错误类型 + `thiserror` |
| 图表 | recharts |
| 前端测试（Vitest） | 1516 个测试（102 个测试文件，语句覆盖率 ~84%，阈值见 `vite.config.ts`） |
| Rust 测试 | `#[cfg(test)]` 内联单元测试 + 集成测试（255 个测试，含内存 SQLite 集成） |
| 代码检查 | Biome |
| Git Hooks | Lefthook（pre-commit: 大文件检查 + Rust fmt/clippy + Biome；pre-push: tsc 类型检查 + 前端全量测试 + Rust 测试） |
| CI | GitHub Actions（Biome + tsc + Vitest 覆盖率 + cargo fmt/clippy/test） |

## 快速开始

### 系统要求

- Windows 10 及以上版本

### 安装

从 [Releases](https://github.com/anthonysu/raven/releases) 页面下载最新版本：

- `Raven_1.9.0_x64-setup.exe` — 标准安装程序（推荐）
- `Raven_1.9.0_x64_en-US.msi` — MSI 安装包（适合企业部署）

下载后双击运行安装程序，按向导提示完成安装即可。首次启动会自动进入 6 步引导，按顺序完成：

1. **配置文本模型（推荐 MiMo）** — 打开 [MiMo 开放平台](https://platform.xiaomimimo.com) 注册/登录 → 创建并复制 API Key；引导页选「MiMo」预设（`https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5` 或 `mimo-v2.5-pro`），粘贴 Key 后点「测试连接」。
2. **选择英语水平** — 按自己认得的考试/学段选择（小学 / 中考 / 高考 / 大学四级 / 六级 / 专业四级 / 专业八级·雅思托福），所有训练内容会据此调整难度；可跳过，稍后在「设置 → 英语水平定级」调整。
3. **配置语音（TTS/ASR）** — 同一 Key 可直接共用；推荐 TTS `mimo-v2.5-tts`（音色如「冰糖」「Mia」）+ ASR `mimo-v2.5-asr`。也可跳过，稍后在「设置 → 语音」补齐。
4. **体验预览 / 完成** — 了解功能入口后开始使用。

非 MiMo 用户可选 OpenAI / DeepSeek 预设，或 Ollama 本地模型（`http://localhost:11434/v1`）。

## 开发命令

```bash
# 前端开发（Vite dev server，端口 5173）
npm run dev

# 完整 Tauri 开发（启动 Vite + 编译 Rust + 打开桌面窗口）
npm run tauri dev

# 构建前端
npm run build

# 构建完整桌面应用
npm run tauri build

# 代码检查
npm run lint

# 运行测试
npm run test

# 运行测试（含覆盖率报告）
npm run test:coverage

# 添加 shadcn/ui 组件
npx shadcn add <component>
```

Rust 后端修改需要使用 `npm run tauri dev`（而非 `npm run dev`）。

## 项目结构

```
src/
├── components/          # 共享组件（知识图谱、布局、侧边栏、ExerciseCard、VocabularySection、OnboardingDialog、MarkdownContent、LevelEstimateBadge；analytics/LevelProgressCard、placement/PlacementTestDialog 等）
├── contexts/            # React Context（GoalsContext 学习目标共享上下文）
├── hooks/               # 自定义 Hooks（useStreamChat、useLLMStreamPage、useAudioPlayer、usePhaseMachine、useRecording、useAbortable、useReadAloud、useGraphData、useStaleGuard 等；级别体系：useProficiencyLevel / useLevelEstimation / usePlacementTest / useEffectivePracticeLevel；useAnalytics/ 子目录含 index 入口 + 6 个分析子 hook）
├── lib/                 # 工具库（db/ 数据访问层、解析、任务状态、类型配置、fetch 工具、缓存工具、Zod schemas、CSV 工具、练习统计、历史呈现注册表；级别体系：levels 级别尺子、level-estimation 估计引擎、level-estimation-samples 样本归一化）
├── pages/               # 页面（仪表盘、写作、阅读、口语、听力、生词本、复习、历史、分析、设置、弱项训练；reducer 独立为 *-reducer.ts 纯函数模块；settings/ 子目录下 9 张设置卡片；speaking/、vocabulary/ 子目录承载逐句会话与词汇导入逻辑）
├── prompts/             # LLM 提示词模板（写作、阅读（含语言检测/知识图谱/摘要）、练习、听力、口语、生词富化、水平定级测试）
├── services/            # LLM 流式服务、TTS 语音服务、ASR 语音识别服务、生词富化服务（vocabulary-enrichment）、复习通知服务
├── test/                # 测试配置和共享 mock 工具
└── types/               # TypeScript 类型定义

src-tauri/
├── src/
│   ├── commands/        # Tauri Command 处理器（按领域拆分为 12 个文件：7 个业务模块 + sse/proxy/ssrf/shared/mod）
│   │   ├── models.rs    # 模型配置（CRUD + 默认设置 + Keychain 集成）
│   │   ├── words.rs     # 生词本（CRUD + 复习统计 + FSRS 更新）
│   │   ├── history.rs   # 历史记录（CRUD + 图谱数据更新）
│   │   ├── settings.rs  # 通用设置 + TTS 配置
│   │   ├── learning.rs  # 学习打卡 + 每日目标 + Sidebar 聚合
│   │   ├── fsrs.rs      # FSRS 间隔重复算法入口
│   │   ├── export.rs    # CSV/Anki 导出 + 数据库备份/恢复（含原生对话框路径）
│   │   ├── proxy.rs     # LLM/TTS/ASR 请求代理（reqwest + post_json 传输助手，密钥不出主进程）
│   │   ├── sse.rs       # SSE 流式解析引擎（行切分 + 多字节 UTF-8 跨块解码）
│   │   ├── ssrf.rs      # SSRF 防护校验（私网段拒绝/回环放行、IPv4 内嵌 IPv6 前缀、DNS 重绑定复检）
│   │   ├── shared.rs    # 共享 DTO 类型 + 行映射器 + with_db!/with_db_read! 宏
│   │   └── mod.rs       # 子模块导出
│   ├── credentials.rs   # OS Keychain 凭据存储（keyring crate 封装）
│   ├── db.rs            # SQLite 连接池（r2d2）+ 迁移执行 + WAL 模式
│   ├── error.rs         # AppError 结构化错误类型 + From 转换
│   ├── fsrs.rs          # FSRS 算法实现（FsrsState enum + 单元测试）
│   ├── repository/      # 数据访问层（7 个文件：6 个业务模块 + mod）
│   ├── lib.rs           # 应用入口（插件注册 + 数据库初始化 + 系统托盘 + tracing 日志）
│   └── main.rs          # Tauri 二进制入口
├── migrations/          # SQLite 数据库迁移（001-014）
├── capabilities/        # WebView 权限（HTTP 回环地址白名单等）
└── tauri.conf.json      # 应用配置
```

## 测试

### 前端测试（Vitest）

```bash
npm test                # 运行所有测试
npm run test:watch      # watch 模式
```

当前覆盖 **1516 个测试**，分布在 102 个测试文件，语句覆盖率 **~84%**：

- `src/lib/parse-utils.test.ts` — JSON 解析、答案比对、段落分割、`extractJsonSafe` Zod schema 校验
- `src/lib/fetch-utils.test.ts` — `smartFetch` 双通道 fetch + 超时 + AbortSignal + `delayWithAbort`
- `src/lib/request-utils.test.ts` — 请求守卫（`guardedInvoke` 超时/中止样板、`raceWithAbort` 按等待者 abort 桥接）
- `src/lib/cache.test.ts` — `createCachedFetcher` 缓存 + FIFO 驱逐 + 失效
- `src/lib/db.test.ts` — 数据库工具函数（`getLocalDate`、`aggregateCorrections`、`countStreak`）
- `src/lib/error-utils.test.ts` — 错误消息提取
- `src/lib/schemas.test.ts` — Zod schema 运行时校验（LLM JSON 响应）
- `src/lib/type-config.test.ts` — 错误类别 → 练习类型映射
- `src/lib/task-status.test.ts` — 后台任务状态机
- `src/lib/utils.test.ts` — 工具函数（`cn`、`getScoreColor`、`getScoreBgColor`）
- `src/lib/analytics.test.ts` — 分析工具函数
- `src/lib/csv-utils.test.ts` — CSV 解析工具
- `src/lib/word-utils.test.ts` — 单词工具函数
- `src/lib/exercise-stats.test.ts` — 练习统计（熟练度加权、错题提取）
- `src/lib/history-presentation.test.ts` — 历史呈现注册表（类型 → 摘要/分数文案）
- `src/lib/vocabulary-parser.test.ts` — 生词词条解析工具
- `src/lib/levels.test.ts` — 级别尺子（级别码校验、规格完备性、练习难度派生、prompt 规格块）
- `src/lib/practice-options.test.ts` — 练习难度标签格式化（级别码 ≈ 考试锚点双标注、旧值透传）
- `src/lib/level-estimation.test.ts` — 级别估计引擎（时间衰减、分数调档、置信度、建议规则、定级计分）
- `src/hooks/use-abortable.test.ts` — `useAbortable` 可取消异步 hook
- `src/hooks/use-stream-chat.test.ts` — LLM 流式调用 hook
- `src/hooks/use-llm-stream-page.test.ts` — LLM 流式页面集成
- `src/hooks/use-phase-machine.test.ts` — 阶段状态机
- `src/hooks/use-recording.test.ts` — 麦克风录音 hook
- `src/hooks/use-audio-player.test.ts` — TTS 音频播放 hook（AbortController + 状态管理）
- `src/hooks/use-theme.test.tsx` — 主题切换 hook
- `src/hooks/use-add-to-vocabulary.test.ts` — 生词本 hook
- `src/hooks/use-hidden-effect.test.tsx` — 持久化页面隐藏判定 hook
- `src/hooks/use-level-estimation.test.ts` — 被动级别估计（归一化、级别回退、防御性排序、建议）
- `src/hooks/use-placement-test.test.ts` — AI 定级测试生命周期（生成、无效题过滤、计分持久化、应用）
- `src/hooks/use-proficiency-level.test.ts` — 全局级别响应式 store（水合与手动设置优先级）
- `src/hooks/use-effective-practice-level.test.ts` — 听力/口语难度级别派生与提交时定格
- `src/hooks/use-stale-guard.test.ts` — 过期响应守卫（晚到的旧提交结果被丢弃）
- `src/hooks/use-graph-data.test.ts` — 知识图谱数据加载
- `src/hooks/use-language-detection.test.ts` — 语言检测
- `src/hooks/use-analytics/index.test.ts` — useAnalytics 主入口 hook
- `src/hooks/use-analytics/use-exercise-analytics.test.ts` — 练习数据分析子 hook
- `src/hooks/use-analytics/use-writing-analytics.test.ts` — 写作纠错分析子 hook
- `src/hooks/use-analytics/use-level-analytics.test.ts` — 分技能级别估计子 hook
- `src/hooks/use-analytics/use-listening-speaking-analytics.test.ts` — 听力/口语得分趋势
- `src/hooks/use-analytics/use-recent-sessions.test.ts` — 近期学习会话聚合
- `src/pages/DashboardPage.test.tsx` — 仪表盘页面
- `src/pages/ExercisePage.test.tsx` — 弱项训练页面
- `src/pages/ExerciseReducer.test.ts` — 弱项训练 reducer 纯函数
- `src/pages/CorrectPage.test.tsx` — 写作训练页面
- `src/pages/ReadingPage.test.tsx` — 阅读训练页面
- `src/pages/SpeakingPage.test.tsx` — 口语训练页面
- `src/pages/SpeakingReducer.test.ts` — 口语 reducer 纯函数
- `src/pages/ListeningPage.test.tsx` — 听力训练页面
- `src/pages/ListeningReducer.test.ts` — 听力 reducer 纯函数
- `src/pages/speaking/use-speaking-session.test.ts` — 口语逐句媒体管线 hook
- `src/pages/vocabulary/use-add-word.test.ts` — 手动加词（等级透传）
- `src/pages/vocabulary/use-batch-enrich.test.ts` — 批量补全（失败计数与汇总降级）
- `src/pages/vocabulary/use-batch-runner.test.ts` — 批量运行骨架（互斥并发）
- `src/pages/vocabulary/use-vocabulary-import.test.ts` — CSV/TXT 导入（全量去重与失败计数）
- `src/pages/HistoryPage.test.tsx` — 历史记录页面
- `src/pages/HistoryDetailPage.test.tsx` — 历史详情页面
- `src/pages/VocabularyPage.test.tsx` — 生词本页面
- `src/pages/ReviewPage.test.tsx` — 复习翻卡页面
- `src/pages/SettingsPage.test.tsx` — 设置页面
- `src/pages/AnalyticsPage.test.tsx` — 分析面板页面
- `src/pages/settings/ModelCard.test.tsx` — 文本模型设置
- `src/pages/settings/VoiceCard.test.tsx` — 语音模型设置
- `src/pages/settings/GoalCard.test.tsx` — 学习目标设置
- `src/pages/settings/ThemeCard.test.tsx` — 外观设置
- `src/pages/settings/AboutCard.test.tsx` — 关于页面
- `src/pages/settings/BackupCard.test.tsx` — 数据备份
- `src/pages/settings/NotificationCard.test.tsx` — 通知设置
- `src/pages/settings/ReviewCard.test.tsx` — 复习设置
- `src/pages/settings/LevelCard.test.tsx` — 英语水平定级（自报级别、被动估计、AI 定级测试入口）
- `src/pages/settings/voice-reducer.test.ts` — 语音设置 reducer
- `src/components/Sidebar.test.tsx` — 侧边栏导航
- `src/components/Layout.test.tsx` — 布局组件
- `src/components/OnboardingDialog.test.tsx` — 新手引导
- `src/components/placement/PlacementTestDialog.test.tsx` — AI 定级测试对话框（引导 → 答题 → 结果向导）
- `src/components/PersistentRoutes.test.tsx` — 持久化路由
- `src/components/SpeakButton.test.tsx` — 朗读按钮
- `src/components/InlineErrorBoundary.test.tsx` — 内联错误边界
- `src/components/KnowledgeGraph.test.tsx` — 知识图谱组件
- `src/components/analytics/StatCard.test.tsx` — 统计卡片
- `src/components/analytics/LevelProgressCard.test.tsx` — 分技能级别雷达卡（雷达数据、置信度、建议）
- `src/contexts/GoalsContext.test.tsx` — 学习目标上下文（goalsToRecord + Provider 行为）
- `src/lib/db/models.test.ts` — 模型 DB 操作
- `src/lib/db/words.test.ts` — 生词 DB 操作
- `src/lib/db/history.test.ts` — 历史 DB 操作
- `src/lib/db/learning.test.ts` — 学习 DB 操作
- `src/lib/db/review.test.ts` — 复习 DB 操作
- `src/lib/db/settings.test.ts` — 设置 DB 操作
- `src/lib/db/tts.test.ts` — TTS DB 操作
- `src/lib/db/utils.test.ts` — 数据访问层共享纯函数与 DTO 类型
- `src/prompts/speaking.test.ts` — 口语 prompt 模板
- `src/prompts/listening.test.ts` — 听力 prompt 模板
- `src/prompts/correct.test.ts` — 写作纠错 prompt 模板（级别规格、估级字段）
- `src/prompts/reading.test.ts` — 阅读 prompt 模板（六维章节、级别规格）
- `src/prompts/exercise.test.ts` — 练习 prompt 模板（级别规格与向后兼容）
- `src/prompts/placement.test.ts` — 定级测试命题 prompt 模板
- `src/prompts/enrichment.test.ts` — 生词富化 prompt 模板
- `src/services/llm.test.ts` — LLM 服务层
- `src/services/notifications.test.ts` — 复习通知服务
- `src/services/tts.test.ts` — TTS 语音合成服务
- `src/services/asr.test.ts` — ASR 语音识别服务（WAV 编码 + 转写）
- `src/services/vocabulary-enrichment.test.ts` — 生词富化服务（按模型键控缓存）

### Rust 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

内联 `#[cfg(test)]` 模块覆盖纯函数逻辑和数据库集成测试（通过内存 SQLite），当前共 **255 个测试**：

- `repository::words` — 生词 CRUD、输入校验、重复添加幂等、复习统计、FSRS 原子更新、等级标签白名单与补全写入（38 个测试）
- `repository::history` — 历史记录 CRUD、类型过滤、分页、限幅、难度级别持久化（27 个测试）
- `repository::models` — 模型配置 CRUD、默认模型设置、Base URL 格式校验（20 个测试）
- `repository::learning` — 学习打卡、目标管理、Sidebar 聚合、连续天数计算（19 个测试，含单元 + 集成）
- `repository::export` — CSV/Anki 净化函数、CSV/Anki 导出集成测试（17 个测试）
- `db::tests` — Base64 解码、测试数据库创建与迁移/隔离、迁移校验和记录与旧版迁移回填、迁移清单完整性（19 个测试）
- `commands::proxy` — 代理请求体构建（TTS/ASR/连接测试）、URL 拼接（仅缺失时追加）、流式 URL 推导、本地回环判定（20 个测试）
- `commands::sse` — SSE 行解析、行切分、多字节 UTF-8 跨块解码、单事件大小上限、完成标记仅分发一次（14 个测试）
- `commands::ssrf` — SSRF 防护（私网/链路本地拒绝、回环放行、IPv4 内嵌 IPv6 前缀拒绝、DNS 解析后逐 IP 复检）（5 个测试）
- `fsrs::tests` — FSRS 算法状态转换、lapse 计数、stability 增长与顺序（含难度触顶场景）、enum 转换、保留率解析（12 个测试）
- `commands::settings` — 设置命令层：枚举键校验、TTS 批量写入（单事务 + Keychain 路由）、TTS 配置构建（9 个测试）
- `repository::tests` — 枚举与写入校验（`validate_review_status` / `validate_record_type` / `validate_goal_type` / `validate_difficulty_level` / `validate_word_level`）（17 个测试）
- `error::tests` — `From` 转换（rusqlite/keyring/io 错误映射与脱敏）、`Display` 输出、`Serialize` 结构（8 个测试）
- `repository::settings` — 键值对 CRUD、TTS 配置查询（7 个测试）
- `credentials::tests` — Keychain 读缓存（过期未命中、旧读不覆盖并发写、空档回填）（4 个测试）
- `dto` — DTO 行映射与密钥脱敏、学习活动枚举白名单一致性（4 个测试）
- `commands::models` — 模型命令层：默认模型解析（内存库 fallback 链）（3 个测试）
- `commands::export` — 导出命令层：写入路径白名单校验、原生保存对话框导出、数据库备份（对话框/默认位置）与恢复（10 个测试）
- `commands::history` — 历史命令层：轻量列行为与类型过滤（内存库）（2 个测试）

> **Windows 开发者注意**：`build.rs` 使用 `std::panic::catch_unwind` 包裹 `tauri_build::build()`，以捕获 Windows 资源编译器（rc.exe）的 `std::process` 管道竞态 panic（`Os { code: 0 }`）。该 panic 不影响库代码编译，仅跳过图标/manifest 嵌入步骤。运行 `cargo test` 时会看到一条 `cargo:warning` 告警，属正常现象，测试将正常执行。

### 类型检查与 Lint

```bash
npx tsc -b                         # TypeScript 类型检查（project references，与 build/CI 一致）
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 类型检查
npm run lint                       # Biome 代码检查
```

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)（中英双语）。

## 许可证

MIT © Anthony Su
