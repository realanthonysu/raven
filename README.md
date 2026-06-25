# Raven

中文 | [English](./README_en.md)

![version](https://img.shields.io/badge/version-v1.8.0-blue)
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
- 快速入口（写作/阅读/听力/口语/词汇复习）
- 近期学习时间线

### 写作助手

粘贴英文文本，AI 自动进行语法纠错和写作建议。

- 错误识别与分类（主谓一致、时态、冠词、拼写等）
- 写作改进建议
- 一键复制修正文本或替换输入
- 纠错结果可一键加入生词本，自动 LLM 补全

### 阅读助手

粘贴英文文章，从六个维度进行深度阅读分析：

1. **参考翻译** — 完整中文翻译
2. **重点词汇** — 5-8 个核心词汇，含音标、搭配、例句
3. **句子拆解** — 复杂句式结构分析（最多 10 句）
4. **语法分析** — 语法要点提取（最多 10 项）
5. **背景与技巧** — 领域背景 + 翻译技巧
6. **延伸思考** — 批判性思维与开放性问题

另有交互式**知识图谱**（Cytoscape.js），支持中英文切换和全屏模式。分析完成后可点击"新文章"按钮重置状态，开始新的精读。

### 口语练习

跟读模仿句子，录音后 AI 评分纠错：

- LLM 生成句子 — 选择难度（初级/中级/高级）和主题（日常对话、商务英语、旅游出行等）
- 录音跟读 — 逐句录音，ASR 语音识别转写
- AI 评分 — LLM 对比原文和转写结果，从准确度、流利度、发音三维度评分，给出改进建议

### 听力练习

TTS 播放句子，用户听写，AI 自动评分：

- LLM 生成句子 — 可选难度和主题
- TTS 语音播放 — 支持多种音色和语速
- 听写输入 — 用户听后输入听到的内容
- 自动评分 — 对比原文和听写结果，精确到单词级别打分
- 错句词汇提取 — 从错误句子中提取重点词汇，一键加入生词本

### 生词本

在阅读/写作/听力助手中点击单词或通过"添加到生词本"按钮保存词汇。支持难度标签（CET-4/6、TEM-4/8）。

- 手动添加词汇（自动 LLM 补全音标、释义、搭配、例句）
- CSV/TXT 批量导入（支持 RFC 4180 引号字段、自动去重、自动补全）
- 导出为 CSV 或 Anki 导入格式（Tab 分隔）
- 单个/批量补全缺失数据

### 间隔复习

翻卡界面 + FSRS（Free Spaced Repetition Scheduler）间隔重复算法：

- 正面：单词 + 音标；背面：释义、搭配、例句
- 自评："不认识"（重置间隔）、"模糊"（调整间隔）、"认识"（增长间隔）
- 连续多次"认识"自动升级为 `mastered`
- FSRS 算法根据记忆稳定性和难度动态计算复习间隔
- 仅显示到期需复习的单词

### 弱项训练

基于写作批改数据自动识别薄弱环节，生成针对性练习题：

- 智能推荐 — 分析近 10 篇批改记录，自动识别高频错误类别
- 多样题型 — 填空题（时态/主谓一致/单复数）、改错题（冠词/介词）、重写题（用词/句式）
- 即时反馈 — 完成后统一对答案，展示正确答案和详细解析
- 历史追踪 — 练习结果持久化，可回看练习详情

### 历史与分析

- 所有学习记录保存至 SQLite，支持类型筛选（写作/阅读/口语/听力/练习）
- 分页加载（每次 20 条），详情页含可展开卡片和知识图谱
- 分析面板：错误类别分布、趋势图、得分趋势、学习画像雷达图、弱项推荐

### 其他特性

- **新用户引导** — 首次启动 4 步引导对话框：配置 API Key → 测试连接 → 功能预览 → 快速入门
- **每日复习通知** — 应用启动时检查待复习词数，通过浏览器 Notification API 发送系统通知
- **学习 streak** — 侧边栏显示连续学习天数和待复习词数 badge
- **每日学习目标** — 侧边栏显示每日目标进度条（复习/练习/阅读/写作/听力）
- **后台任务** — 写作助手和阅读助手在页面切换时保持挂载，状态栏显示任务状态
- **数据管理** — 导出 CSV/Anki 格式，数据库备份（SQLite backup API，含目标路径存在性校验）
- **系统托盘** — 关闭窗口时最小化到托盘而非退出；左键单击托盘图标恢复窗口
- **复习队列持久化** — ReviewPage 当前复习队列写入 localStorage，意外中断后可恢复
- **分析时间范围筛选** — AnalyticsPage 支持 7/30/90 天时间范围切换
- **结构化错误** — 后端 `AppError` 携带 `category`（database/credential/export/io）和 `message` 字段，前端可按类别分支处理

## 安全

### API Key 存储

API Key 不再以明文或 Base64 存储在 SQLite 中，而是写入 **OS Keychain**（通过 `keyring` crate）：

- Windows: Credential Manager
- macOS: Keychain
- Linux: Secret Service（GNOME Keyring / KWallet）

每个模型配置的 API Key 以 `model_{id}` 为账户名存储在 `raven` 服务下；TTS API Key 以 `tts` 为账户名存储。即使数据库文件泄露，也无法获取 API Key。

模型列表查询接口（`get_models`）**不返回 api_key 字段**，编辑模型时通过独立的 `get_model_api_key` 命令按需读取。

### HTTP 权限

WebView 的 HTTP 请求权限（`capabilities/default.json`）采用分层策略：

- **HTTPS 保持开放**（`https://**`）— 用户可自定义任意 OpenAI 兼容端点（Mistral / Groq / Together AI / 自托管 LLM 等）
- **HTTP 仅限本地回环**（`127.0.0.1` / `localhost`）— 防止 SSRF 访问内网 HTTP 服务（路由器、云 metadata 服务等），同时保留 Ollama 等本地部署能力

### 导出净化

- **CSV 导出** — 对用户可控字段进行公式注入防御：以 `=` `+` `-` `@` 开头的单元格会被前缀单引号 `'`，防止 Excel/LibreOffice 将其解释为公式执行
- **Anki 导出** — 转义 HTML 特殊字符（`&` `<` `>`），防止 Anki 卡片渲染异常或 XSS；替换 Tab/换行符防止字段错位

### 数据库完整性

- `PRAGMA foreign_keys=ON` 在连接初始化时启用外键约束
- 模型新增/更新采用"先提交 DB 事务、再写 Keychain"策略：若 Keychain 写入失败，删除刚插入的 DB 行作为补偿，避免留下无 Key 的孤儿记录
- 备份目标路径存在性校验，防止覆盖已有文件造成数据丢失
- 后端枚举字段（`review_status` / `record_type` / `goal_type`）入库前校验合法值，防止前端传入非法枚举破坏查询语义

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Tauri v2 |
| 前端 | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v3, lucide-react |
| 文本模型 | OpenAI 兼容 LLM API（可配置） |
| 语音模型 | TTS 语音合成 + ASR 语音识别（OpenAI 兼容 API，可配置） |
| 图谱 | Cytoscape.js |
| 数据库 | SQLite（rusqlite + r2d2 连接池，WAL 模式） |
| 凭据存储 | OS Keychain（`keyring` crate） |
| 结构化日志 | `tracing` + `tracing-subscriber`（env-filter） |
| Schema 校验 | Zod v4（LLM JSON 响应运行时校验） |
| 错误处理 | `AppError` 结构化错误类型 + `thiserror` |
| 图表 | recharts |
| 前端测试 | Vitest（231 个测试） |
| Rust 测试 | `#[cfg(test)]` 内联单元测试 |
| 代码检查 | Biome |
| Git Hooks | Lefthook（pre-commit: 大文件检查 + Rust fmt/clippy + Biome；pre-push: 全量测试） |

## 快速开始

### 系统要求

- Windows 10 及以上版本

### 安装

从 [Releases](https://github.com/anthonysu/raven/releases) 页面下载最新版本：

- `Raven_1.8.0_x64-setup.exe` — 标准安装程序（推荐）
- `Raven_1.8.0_x64_en-US.msi` — MSI 安装包（适合企业部署）

下载后双击运行安装程序，按向导提示完成安装即可。首次启动会自动进入引导流程，配置文本模型和语音模型的 API Key。

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

# 添加 shadcn/ui 组件
npx shadcn@latest add <component>
```

Rust 后端修改需要使用 `npm run tauri dev`（而非 `npm run dev`）。

## 项目结构

```
src/
├── components/          # 共享组件（知识图谱、布局、侧边栏、ExerciseCard、VocabularySection、OnboardingDialog 等）
├── hooks/               # 自定义 Hooks（useStreamChat、useAudioPlayer、usePhaseMachine、useRecording、useAbortable、useLatestRef 等）
├── lib/                 # 工具库（数据库、解析、任务状态、类型配置、fetch 工具、缓存工具、Zod schemas）
├── pages/               # 页面（仪表盘、写作、阅读、口语、听力、生词本、复习、历史、分析、设置、弱项训练）
├── prompts/             # LLM 提示词模板（写作、阅读、练习、听力、口语；图谱提示词定义在对应 hook 中）
├── services/            # LLM 流式服务、TTS 语音服务、ASR 语音识别服务、复习通知服务
├── test/                # 测试配置和共享 mock 工具
└── types/               # TypeScript 类型定义

src-tauri/
├── src/
│   ├── commands/        # Tauri Command 处理器（按领域拆分为 7 个子模块）
│   │   ├── models.rs    # 模型配置（CRUD + 默认设置 + Keychain 集成）
│   │   ├── words.rs     # 生词本（CRUD + 复习统计 + FSRS 更新）
│   │   ├── history.rs   # 历史记录（CRUD + 图谱数据更新）
│   │   ├── settings.rs  # 通用设置 + TTS 配置
│   │   ├── learning.rs  # 学习打卡 + 每日目标
│   │   ├── fsrs.rs      # FSRS 间隔重复算法入口
│   │   ├── export.rs    # CSV/Anki 导出 + 数据库备份
│   │   ├── shared.rs    # 共享 DTO 类型
│   │   └── mod.rs        # 子模块导出
│   ├── credentials.rs   # OS Keychain 凭据存储（keyring crate 封装）
│   ├── db.rs            # SQLite 连接池（r2d2）+ 迁移执行 + WAL 模式
│   ├── error.rs         # AppError 结构化错误类型 + From 转换
│   ├── fsrs.rs          # FSRS 算法实现（FsrsState enum + 单元测试）
│   ├── repository.rs    # 数据访问层（SQL 查询 + 枚举校验 + CSV/Anki 净化）
│   ├── lib.rs           # 应用入口（插件注册 + 数据库初始化 + 系统托盘 + tracing 日志）
│   └── main.rs          # Tauri 二进制入口
├── migrations/          # SQLite 数据库迁移（001-008）
├── capabilities/        # WebView 权限（HTTP 域名白名单等）
└── tauri.conf.json      # 应用配置
```

## 测试

### 前端测试（Vitest）

```bash
npm test                # 运行所有测试
npm run test:watch      # watch 模式
```

当前覆盖 **231 个测试**，分布在 12 个测试文件：

- `src/lib/parse-utils.test.ts` — JSON 解析、答案比对、段落分割、`extractJsonSafe` Zod schema 校验
- `src/lib/fetch-utils.test.ts` — `smartFetch` 双通道 fetch + 超时 + AbortSignal
- `src/lib/cache.test.ts` — `createCachedFetcher` 缓存 + FIFO 驱逐 + 失效
- `src/lib/type-config.test.ts` — 错误类别 → 练习类型映射
- `src/lib/task-status.test.ts` — 后台任务状态机
- `src/hooks/use-abortable.test.ts` — `useAbortable` 可取消异步 hook
- `src/hooks/use-stream-chat.test.ts` — LLM 流式调用 hook
- `src/hooks/use-llm-stream-page.test.ts` — LLM 流式页面集成
- `src/hooks/use-phase-machine.test.ts` — 阶段状态机
- `src/pages/ExercisePage.test.tsx` — 弱项训练页面
- `src/pages/ReviewPage.test.tsx` — 复习翻卡页面
- `src/services/llm.test.ts` — LLM 服务层

### Rust 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

内联 `#[cfg(test)]` 模块覆盖纯函数逻辑（不依赖 DB / Keychain）：

- `repository::tests` — 枚举校验（`validate_review_status` / `validate_record_type` / `validate_goal_type`）、CSV 公式注入防御（`sanitize_csv_cell`）、Anki HTML 转义（`sanitize_anki_cell`）
- `error::tests` — `From<io::Error>` / `From<rusqlite::Error>` / `From<keyring::Error>` 转换、`Display` 输出、`Serialize` 结构（`category` + `message` 双字段）
- `fsrs::tests` — FSRS 算法首评状态转换、lapse 计数、stability 增长、`next_review_at` 本地时区、status 字符串映射、`FsrsState` enum 双向转换

### 类型检查与 Lint

```bash
npx tsc --noEmit                   # TypeScript 类型检查
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 类型检查
npm run lint                       # Biome 代码检查
```

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)（中英双语）。

## 许可证

MIT © Anthony Su
