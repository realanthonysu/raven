# Raven

[English](./README.md) | 中文

AI 驱动的英语学习桌面助手

![version](https://img.shields.io/badge/version-v1.0.1-blue)
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

- 所有分析保存至 SQLite，支持类型筛选（写作/阅读）
- 详情页含可展开卡片和知识图谱
- 分析面板：错误类别分布、趋势图、会话摘要

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

## 快速开始

```bash
npm install
npm run tauri dev        # 完整开发模式（Vite + Rust + 桌面窗口）
npm run dev              # 仅前端（端口 5173）
npm run tauri build      # 构建桌面应用
npm run lint             # 代码检查
npm run test             # 运行测试
```

## 项目结构

```
src/
├── components/          # 共享组件（知识图谱、布局、侧边栏等）
├── lib/                 # 工具库（数据库、解析、任务状态、类型配置）
├── pages/               # 页面（写作、阅读、生词本、复习、历史、分析、设置）
├── services/            # LLM 流式服务
├── test/                # Vitest 配置
└── types/               # TypeScript 类型定义

src-tauri/
├── src/lib.rs           # Tauri 插件注册
├── migrations/          # SQLite 数据库迁移（001-004）
├── capabilities/        # WebView 权限
└── tauri.conf.json      # 应用配置
```

## 许可证

MIT © Anthony Su
