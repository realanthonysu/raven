# Raven 测试指南

## 1. 环境准备

### 1.1 已安装的工具链

以下工具已在开发过程中安装，确认版本：

```bash
# Node.js（应已有）
node --version

# Rust
rustc --version    # 应显示 1.95.0+
cargo --version

# MSVC Build Tools
# 确认目录存在：C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC
```

### 1.2 设置 MSVC 环境变量

每次打开新的终端窗口编译 Rust 时，需要先设置 MSVC 环境。在 PowerShell 中执行：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cmd /c "`"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat`" x64 >nul 2>&1 && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } }
```

或者，更简单的方式：**直接使用 VS Developer Command Prompt**（开始菜单搜索 "Developer Command Prompt for VS 2022"），然后在其中运行后续命令。

## 2. 启动应用

### 2.1 安装前端依赖

```bash
cd D:\GitHub\raven
npm install
```

### 2.2 启动开发模式

**方式一：完整 Tauri 应用（推荐）**

在 VS Developer Command Prompt 中执行：

```bash
cd D:\GitHub\raven
npm run tauri dev
```

首次编译 Rust 需要较长时间（约 2-5 分钟），后续编译会快很多。

**方式二：仅前端（快速预览 UI）**

```bash
cd D:\GitHub\raven
npm run dev
```

然后在浏览器打开 http://localhost:1420

> 注意：方式二下，LLM 调用和 SQLite 功能不可用（需要 Tauri 后端）。

### 2.3 打包完整桌面应用

**方式一：打包为安装包（推荐）**

在 VS Developer Command Prompt 中执行：

```bash
cd D:\GitHub\raven
npm run tauri build
```

打包完成后，安装包位于：

```
D:\GitHub\raven\src-tauri\target\release\bundle\
├── msi\          # Windows MSI 安装包
│   └── Raven_0.0.0_x64_en-US.msi
└── nsis\         # NSIS 安装包（可选）
    └── Raven_0.0.0_x64-setup.exe
```

首次打包需要较长时间（约 5-10 分钟），后续增量打包会快很多。

**方式二：仅打包 exe（不生成安装包）**

```bash
cd D:\GitHub\raven
npm run tauri build -- --no-bundle
```

生成的 exe 位于：

```
D:\GitHub\raven\src-tauri\target\release\raven.exe
```

**打包注意事项：**

- 打包前确保已在开发模式下测试过所有功能
- 打包后的应用数据存储在 `C:\Users\<用户名>\AppData\Roaming\raven\`
- MSI 安装包可以直接分发给其他 Windows 用户安装
- 首次安装后需要在设置页面配置 LLM 模型才能使用翻译、纠正、精读功能

**打包体积优化：**

当前打包体积约 5-8 MB（不含 WebView2 运行时）。如果需要减小体积，可在 `src-tauri/Cargo.toml` 中添加：

```toml
[profile.release]
strip = true
lto = true
codegen-units = 1
opt-level = "s"
```

## 3. 配置 LLM 模型

### 3.1 打开设置页面

启动应用后，点击左侧侧边栏的「设置」。

### 3.2 添加模型配置

填写以下信息：

| 字段 | 示例值 | 说明 |
|------|--------|------|
| 配置名称 | Qwen | 任意名称，方便识别 |
| API Key | sk-xxxxxxxx | 你的 API Key |
| Base URL | https://dashscope.aliyuncs.com/compatible-mode/v1 | OpenAI 兼容的 API 地址 |
| 模型名称 | qwen-plus | 模型标识 |

**常见模型配置示例：**

**通义千问（Qwen）：**
- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 模型名称: `qwen-plus` 或 `qwen-turbo`

**月之暗面（Moonshot）：**
- Base URL: `https://api.moonshot.cn/v1`
- 模型名称: `moonshot-v1-8k`

**OpenAI：**
- Base URL: `https://api.openai.com/v1`
- 模型名称: `gpt-4` 或 `gpt-3.5-turbo`

**DeepSeek：**
- Base URL: `https://api.deepseek.com/v1`
- 模型名称: `deepseek-chat`

### 3.3 设置默认模型

添加的第一个模型会自动成为默认模型。如果有多个模型，标记为「默认」的那个会被使用。

## 4. 功能测试

### 4.1 翻译测试

1. 点击侧边栏「翻译」
2. 输入英文文本，例如：

```
Iran Standoff and Peace Talks: Amid escalating tensions and stalled negotiations, President Trump cancelled a planned trip for US envoys to Pakistan, stating "we have all the cards," Reuters reports.
```

3. 点击「翻译」按钮
4. 等待流式输出完成
5. 验证结果包含 4 个卡片：
   - 翻译结果
   - 用词分析（应包含固定搭配、地道表述等标注）
   - 句子结构拆解
   - 翻译技巧提示

6. 再测试中文输入，例如：

```
他虽然很累，但还是坚持完成了工作。
```

### 4.2 纠正测试

1. 点击侧边栏「纠正」
2. 输入包含错误的英文文本，例如：

```
He go to school yesterday. I big like this movie. How are you? I very tired today.
```

3. 点击「开始纠正」
4. 验证结果包含 5 个卡片：
   - 语法纠正（红色标注错误，绿色标注修正）
   - 词汇纠正
   - 地道表达纠正
   - 句型分析
   - 纠正总结

### 4.3 精读测试

1. 点击侧边栏「精读」
2. 粘贴一段英文文章，例如：

```
The rapid advancement of artificial intelligence has sparked intense debate about its impact on employment. While some experts argue that AI will create more jobs than it eliminates, others warn of widespread displacement. A recent study by the World Economic Forum suggests that by 2030, AI could displace 85 million jobs globally while creating 97 million new ones. However, the transition period may be challenging for workers who need to acquire new skills.
```

3. 点击「开始精读」
4. 验证：
   - 左侧显示原文，单词可点击
   - 右侧依次展示：词汇解析、句法分析、文化背景、核心概念
   - 底部出现知识图谱（Cytoscape.js 可视化）
   - 点击单词后出现「添加到生词本」按钮

### 4.4 生词本测试

1. 在精读页面点击几个单词，添加到生词本
2. 点击侧边栏「生词本」
3. 验证：
   - 添加的单词出现在列表中
   - 可以搜索单词
   - 可以按级别筛选（CET-4 / CET-6 / TEM-4 / TEM-8）
   - 可以为单词设置级别
   - 可以删除单词

### 4.5 历史记录测试

1. 执行几次翻译和纠正操作
2. 点击侧边栏「历史记录」
3. 验证：
   - 记录按时间倒序展示
   - 可以按类型筛选（翻译 / 纠正 / 精读）
   - 点击「展开」可查看完整结果
   - 可以删除记录

## 5. 常见问题

### Q: 编译报错 `link.exe` 相关错误

确保在 VS Developer Command Prompt 中运行，或正确设置了 MSVC 环境变量。Git 的 `link.exe` 会被优先找到，需要让 MSVC 的 `link.exe` 优先。

### Q: LLM 调用报错 "请先在设置页面配置 LLM 模型"

检查设置页面是否已添加模型，且 API Key 和 Base URL 正确。

### Q: LLM 调用超时或报错 401

- 检查 API Key 是否有效
- 检查 Base URL 是否正确（需要是 OpenAI 兼容格式）
- 检查模型名称是否正确

### Q: 知识图谱不显示

知识图谱需要 LLM 返回有效的 JSON 格式。如果 LLM 返回的格式不正确，图谱会静默失败。可以刷新页面重试。

### Q: SQLite 数据在哪里

数据存储在 Tauri 应用的数据目录中。Windows 上通常在：
```
C:\Users\<用户名>\AppData\Roaming\raven\raven.db
```
