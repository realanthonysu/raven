# Raven 缺陷修复路线图

生成日期：2026-07-19 | 对抗性审阅日期：2026-07-19

---

## ✅ 已修复缺陷

### BUG-1: ReviewPage 保存会话 Schema 缺少 "easy" 评分
- **文件**: `src/pages/ReviewPage.tsx:90`
- **修复**: Schema 中添加 `"easy"` 到 rating enum

### BUG-2: DashboardPage 的 getRecordSummary 不支持 speaking/writing 类型
- **文件**: `src/pages/DashboardPage.tsx`
- **修复**: 添加 speaking 和 writing 类型的处理分支

### BUG-3: useAddToVocabulary 共享状态导致并发 UI 异常
- **文件**: `src/hooks/use-add-to-vocabulary.ts`
- **修复**: addingWord 改为 Set 跟踪并发操作

### BUG-4: HistoryRecord type 双条件检查遗漏
- **文件**: `use-recent-sessions.ts`, `AnalyticsPage.tsx`
- **修复**: 所有 `type === "correct"` 检查点补充 `|| type === "writing"`

### BUG-6: LearningActivity 枚举缺少 Speaking 变体
- **文件**: `src-tauri/src/commands/shared.rs`
- **修复**: 添加 Speaking 变体和 as_str() 映射

### TD-4: LLM fetch 阶段单次重试
- **文件**: `src/services/llm.ts`
- **修复**: streamChat 的 fetch 阶段对网络错误和 5xx 添加 1 次重试（2 秒间隔），SSE 流开始后不重试

### TD-6: getModelApiKey 未使用的 dead code
- **文件**: `src/lib/db.ts`, `src-tauri/src/commands/models.rs`, `src-tauri/src/lib.rs`
- **修复**: 删除 getModelApiKey 函数、db_get_model_api_key Command 及其注册

### P-1: Rust 端英文 doc comments 中文化
- **文件**: `src-tauri/src/error.rs`, `src-tauri/src/fsrs.rs`
- **修复**: 翻译 AppError 枚举/variant/Serialize 的 doc comments 和 5 个 FSRS 常量 doc comments

---

## 对抗性审阅结论（7 个误报，不修复）

| 编号 | 声明 | 审阅结论 |
|------|------|---------|
| P-2 | SQL 注入防护不一致 | **误报**：goal_type 已有 validate_goal_type()；level 受绑定参数保护，无注入风险 |
| P-4 | Analytics 子 hook 注释全英文 | **误报**：声明事实不准确（exercise-analytics 有中文注释），且英文 JSDoc 与代码语言一致 |
| TD-1 | VocabularyPage 过大需拆分 | **误报**：787 行单内聚组件，SpeakingPage 同样大小；SettingsPage 拆分是因为 7 个独立领域，非行数 |
| TD-2 | DashboardPage 重复 JSON 解析 | **误报**：最多 5 条记录的 JSON.parse 重叠，微秒级开销；修复引入过度工程化 |
| TD-3 | 缺少乐观更新 | **误报**：Tauri IPC + 本地 SQLite 为亚毫秒延迟；enrichWord 的 LLM 数据无法预测 |
| NP-1 | ErrorToast 替代 WarningBanner | **误报**：WarningBanner 未被任何文件导入，是 dead code；不应为未使用的组件引入 toast 库 |
| NP-2 | FormReducer 合并表单状态 | **误报**：5 个独立表单字段无交叉依赖，useReducer 会增加样板代码无实际收益 |

---

## 保留的 nice_to_have（暂不修复）

| 编号 | 问题 | 原因 |
|------|------|------|
| TD-5 | HistoryRecord.type 冗余（correct/writing） | 需要跨前后端 + 数据库迁移协调变更，风险收益比不合适 |
| BUG-5 | ListeningPage 半分评分 | 设计如此，非缺陷 |
