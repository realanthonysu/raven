//! 共享类型、DTO 和工具函数，供所有 Command 子模块使用。
//!
//! 包含：
//! - 学习活动类型枚举 [`LearningActivity`]
//! - 数据传输对象（DTO）：[`ModelDto`]、[`WordDto`]、[`HistoryDto`] 等
//! - 入参结构：[`NewModelInput`]、[`NewWordInput`]
//! - 行映射器：[`row_to_word`]、[`row_to_history`]
//! - 连接池辅助宏 [`with_db!`]

use serde::{Deserialize, Serialize};

/// 学习活动类型白名单枚举。
///
/// 用于 [`db_record_learning_activity`] 命令，通过 serde 反序列化
/// 防止 SQL 注入（`activity` 参数会被插入 JSON 路径表达式）。
/// 非法字符串值在 serde 层即被拒绝，不会到达 SQL 查询。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearningActivity {
    /// 写作批改
    Writing,
    /// 阅读精读
    Reading,
    /// 弱项训练
    Exercise,
    /// 听力练习
    Listening,
    /// 口语练习
    Speaking,
    /// 词汇复习
    Review,
}

impl LearningActivity {
    /// 返回活动类型的小写字符串标识，用于 SQL JSON 路径。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Writing => "writing",
            Self::Reading => "reading",
            Self::Exercise => "exercise",
            Self::Listening => "listening",
            Self::Speaking => "speaking",
            Self::Review => "review",
        }
    }
}

// ============================================================================
// Data Transfer Objects (DTOs)
// ============================================================================

/// 模型配置 DTO（前端渲染用）。
///
/// 注意：列表接口中 `api_key` 为空字符串，仅 `get_default_model` 会填充真实值。
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelDto {
    pub id: i64,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

/// 新增模型时前端传入的参数结构。
#[derive(Debug, Deserialize)]
pub struct NewModelInput {
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

/// P3-9: db_add_word 的入参 struct，替代原先 10 个独立参数（超过 clippy::too_many_arguments 阈值 8）。
/// 参考 NewModelInput 模式：前端通过 invoke 传递一个对象，Tauri 反序列化为本结构。
#[derive(Debug, Deserialize)]
pub struct NewWordInput {
    pub word: String,
    pub phonetic: Option<String>,
    pub definition: String,
    pub level: Option<String>,
    pub source_type: Option<String>,
    pub source_text: Option<String>,
    pub notes: Option<String>,
    pub review_status: Option<String>,
}

/// 单词 DTO（前端渲染用），包含完整字段（含 FSRS 状态）。
///
/// FSRS 相关字段（stability、difficulty 等）为 `Option`，保持与旧版迁移前数据的兼容性。
#[derive(Debug, Serialize, Deserialize)]
pub struct WordDto {
    pub id: i64,
    pub word: String,
    pub phonetic: Option<String>,
    pub definition: String,
    pub level: Option<String>,
    pub source_type: Option<String>,
    pub source_text: Option<String>,
    pub notes: Option<String>,
    pub review_status: String,
    pub review_count: Option<i64>,
    pub next_review_at: Option<String>,
    pub created_at: String,
    // FSRS fields (migration 007) — Option for backward compat with pre-migration rows
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub elapsed_days: Option<i64>,
    pub scheduled_days: Option<i64>,
    pub reps: Option<i64>,
    pub lapses: Option<i64>,
    pub state: Option<i64>,
}

/// 学习历史记录 DTO。
///
/// `record_type` 在序列化时重命名为 `"type"` 以匹配前端字段名。
#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryDto {
    pub id: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub input_text: String,
    pub result: String,
    pub graph_data: Option<String>,
    pub created_at: String,
}

/// 复习统计概览 DTO：各类单词的数量汇总。
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewStatsDto {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub mastered_count: i64,
    pub due_count: i64,
}

/// 学习打卡记录 DTO，包含日期和活动 JSON。
#[derive(Debug, Serialize, Deserialize)]
pub struct StreakRowDto {
    pub date: String,
    pub activities: String,
}

/// 学习目标 DTO。
#[derive(Debug, Serialize, Deserialize)]
pub struct GoalDto {
    pub goal_type: String,
    pub target: i64,
}

/// L-10: Sidebar 聚合数据 DTO，合并 4 次 IPC 为 1 次。
#[derive(Debug, Serialize, Deserialize)]
pub struct SidebarDataDto {
    pub review_stats: ReviewStatsDto,
    pub streak: i64,
    pub goals: Vec<GoalDto>,
    pub today_activities: Option<String>,
}

/// TTS（文本转语音）完整配置 DTO。
///
/// `api_key` 从 OS Keychain 读取；其他字段从数据库 settings 表读取。
/// 未设置时使用默认值（OpenAI TTS-1、alloy 语音、1.0x 速度）。
#[derive(Debug, Serialize, Deserialize)]
pub struct TtsConfigDto {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub voice: String,
    pub speed: f64,
}

// ============================================================================
// Helper macro: get connection from pool + error conversion
// ============================================================================

/// 从连接池获取只读数据库连接并执行闭包体。
///
/// L-2: 与 `with_db!` 不同，此宏传入 `&Connection`（不可变引用），
/// 允许多个并发读操作真正并行（Rust 借用检查器不会序列化不可变引用）。
///
/// 用法：`with_db_read!(db_state, |conn: &Connection| { ... })`
macro_rules! with_db_read {
    ($db:expr, $body:expr) => {{
        let conn = $db
            .0
            .get()
            .map_err(|e| crate::error::AppError::Database(format!("DB pool error: {e}")))?;
        #[allow(clippy::redundant_closure_call)]
        {
            (|| -> Result<_, crate::error::AppError> { $body(&*conn) })()
        }
    }};
}
pub(crate) use with_db_read;

/// 从连接池获取可写数据库连接并执行闭包体，自动将池错误转换为 `AppError::Database`。
///
/// 用法：`with_db!(db_state, |conn: &mut Connection| { ... })`
///
/// 宏内部从 `db.0`（r2d2 Pool）获取连接，传入闭包执行查询，
/// 并将 `r2d2::Error` 自动转换为 `AppError::Database`。
/// 仅在需要事务（`conn.transaction()`）时使用；只读操作请用 `with_db_read!`。
macro_rules! with_db {
    ($db:expr, $body:expr) => {{
        let mut conn = $db
            .0
            .get()
            .map_err(|e| crate::error::AppError::Database(format!("DB pool error: {e}")))?;
        #[allow(clippy::redundant_closure_call)]
        {
            (|| -> Result<_, crate::error::AppError> { $body(&mut *conn) })()
        }
    }};
}
pub(crate) use with_db;

// ============================================================================
// Row mappers
// ============================================================================

/// 将 SQLite 结果行映射为 [`WordDto`]（19 列，含 FSRS 字段）。
///
/// 使用列名访问（而非位置索引），使 SQL SELECT 的列顺序变更不会导致静默数据错位。
pub fn row_to_word(row: &rusqlite::Row) -> rusqlite::Result<WordDto> {
    Ok(WordDto {
        id: row.get("id")?,
        word: row.get("word")?,
        phonetic: row.get("phonetic")?,
        definition: row.get("definition")?,
        level: row.get("level")?,
        source_type: row.get("source_type")?,
        source_text: row.get("source_text")?,
        notes: row.get("notes")?,
        review_status: row.get("review_status")?,
        review_count: row.get("review_count")?,
        next_review_at: row.get("next_review_at")?,
        created_at: row.get("created_at")?,
        stability: row.get("stability")?,
        difficulty: row.get("difficulty")?,
        elapsed_days: row.get("elapsed_days")?,
        scheduled_days: row.get("scheduled_days")?,
        reps: row.get("reps")?,
        lapses: row.get("lapses")?,
        state: row.get("state")?,
    })
}

/// 将 SQLite 结果行映射为 [`HistoryDto`]（6 列）。
///
/// 使用列名访问（而非位置索引），使 SQL SELECT 的列顺序变更不会导致静默数据错位。
pub fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryDto> {
    Ok(HistoryDto {
        id: row.get("id")?,
        record_type: row.get("type")?,
        input_text: row.get("input_text")?,
        result: row.get("result")?,
        graph_data: row.get("graph_data")?,
        created_at: row.get("created_at")?,
    })
}
