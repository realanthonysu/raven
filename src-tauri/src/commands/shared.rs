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
/// `api_key` 从 OS Keychain 读取（桌面应用场景，无前端泄露风险），
/// 编辑模型时前端预填真实 Key 并支持明文/密文切换。
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryDto {
    pub id: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub input_text: String,
    pub result: String,
    pub graph_data: Option<String>,
    pub created_at: String,
}

/// 按 id 关联的历史 result 对（get_history_results_by_type 专用）。
///
/// 返回 id 而非裸字符串列表，让前端与轻量记录列表（get_history_list）按 id
/// 精确配对 —— 消除此前依赖"两次查询顺序一致"按下标配对的错位风险
/// （混入 legacy "writing" 类型、或两次查询间隙插入新记录时都会错位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryResultDto {
    pub id: i64,
    pub result: String,
}

/// 复习统计概览 DTO：各类单词的数量汇总。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewStatsDto {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub mastered_count: i64,
    pub due_count: i64,
}

/// 学习打卡记录 DTO，包含日期和活动 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreakRowDto {
    pub date: String,
    pub activities: String,
}

/// 学习目标 DTO。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalDto {
    pub goal_type: String,
    pub target: i64,
}

/// L-10: Sidebar 聚合数据 DTO，合并 4 次 IPC 为 1 次。
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

// ============================================================================
// Test mocks — 为 Command 层 core 函数提供 ReadRepository / WriteRepository 实现
// ============================================================================

#[cfg(test)]
pub(crate) mod test_mocks {
    use super::*;
    use crate::error::AppError;
    use crate::fsrs::{FsrsCard, FsrsRating, FsrsState, ReviewCalcResult};
    use crate::repository::traits::{ReadRepository, WriteRepository};

    /// 只读 mock —— 预设返回值，用于测试依赖 ReadRepository 的 core 函数。
    /// 字段为 None 时对应方法返回空数据（不报错）。
    pub(crate) struct MockReadRepo {
        pub models: Vec<ModelDto>,
        pub default_model: Option<Option<ModelDto>>,
        pub first_model: Option<Option<ModelDto>>,
        pub words: Vec<WordDto>,
        pub review_stats: Option<ReviewStatsDto>,
        pub review_words: Vec<WordDto>,
        pub history: Vec<HistoryDto>,
        pub history_by_id: Option<Option<HistoryDto>>,
        pub recent_correct_results: Vec<String>,
        pub history_oldest_date: Option<Option<String>>,
        pub history_results_by_type: Vec<HistoryResultDto>,
        pub setting: Option<Option<String>>,
        pub tts_settings: Option<(String, String, String, String)>,
        pub streaks: Vec<StreakRowDto>,
        pub goals: Vec<GoalDto>,
        pub sidebar_data: Option<SidebarDataDto>,
        pub csv_export: Option<String>,
        pub anki_export: Option<String>,
    }

    impl Default for MockReadRepo {
        fn default() -> Self {
            Self {
                models: vec![],
                default_model: None,
                first_model: None,
                words: vec![],
                review_stats: None,
                review_words: vec![],
                history: vec![],
                history_by_id: None,
                recent_correct_results: vec![],
                history_oldest_date: None,
                history_results_by_type: vec![],
                setting: None,
                tts_settings: None,
                streaks: vec![],
                goals: vec![],
                sidebar_data: None,
                csv_export: None,
                anki_export: None,
            }
        }
    }

    impl ReadRepository for MockReadRepo {
        fn get_models(&self) -> Result<Vec<ModelDto>, AppError> {
            Ok(self.models.clone())
        }
        fn get_default_model(&self) -> Result<Option<ModelDto>, AppError> {
            Ok(self.default_model.clone().unwrap_or(None))
        }
        fn get_first_model(&self) -> Result<Option<ModelDto>, AppError> {
            Ok(self.first_model.clone().unwrap_or(None))
        }
        fn get_model_api_key(&self, _id: i64) -> String {
            String::new()
        }
        fn get_words(
            &self,
            _limit: Option<i64>,
            _offset: Option<i64>,
        ) -> Result<Vec<WordDto>, AppError> {
            Ok(self.words.clone())
        }
        fn get_review_stats(&self) -> Result<ReviewStatsDto, AppError> {
            self.review_stats
                .clone()
                .ok_or_else(|| AppError::Database("MockReadRepo: review_stats not set".into()))
        }
        fn get_review_words(&self, _limit: i64) -> Result<Vec<WordDto>, AppError> {
            Ok(self.review_words.clone())
        }
        fn get_history(
            &self,
            _types: Option<&[&str]>,
            _limit: Option<i64>,
            _offset: Option<i64>,
        ) -> Result<Vec<HistoryDto>, AppError> {
            Ok(self.history.clone())
        }
        fn get_history_list(
            &self,
            _types: Option<&[&str]>,
            _limit: Option<i64>,
            _offset: Option<i64>,
        ) -> Result<Vec<HistoryDto>, AppError> {
            Ok(self.history.clone())
        }
        fn get_history_by_id(&self, _id: i64) -> Result<Option<HistoryDto>, AppError> {
            Ok(self.history_by_id.clone().unwrap_or(None))
        }
        fn get_recent_correct_results(&self, _max: i64) -> Result<Vec<String>, AppError> {
            Ok(self.recent_correct_results.clone())
        }
        fn get_history_oldest_date(&self) -> Result<Option<String>, AppError> {
            Ok(self.history_oldest_date.clone().unwrap_or(None))
        }
        fn get_history_results_by_type(
            &self,
            _record_types: &[&str],
            _limit: i64,
        ) -> Result<Vec<HistoryResultDto>, AppError> {
            Ok(self.history_results_by_type.clone())
        }
        fn get_setting(&self, _key: &str) -> Result<Option<String>, AppError> {
            Ok(self.setting.clone().unwrap_or(None))
        }
        fn get_tts_settings(&self) -> Result<(String, String, String, String), AppError> {
            self.tts_settings
                .clone()
                .ok_or_else(|| AppError::Database("MockReadRepo: tts_settings not set".into()))
        }
        fn get_all_streaks(&self) -> Result<Vec<StreakRowDto>, AppError> {
            Ok(self.streaks.clone())
        }
        fn get_learning_goals(&self) -> Result<Vec<GoalDto>, AppError> {
            Ok(self.goals.clone())
        }
        fn get_sidebar_data(&self, _today: &str) -> Result<SidebarDataDto, AppError> {
            self.sidebar_data
                .clone()
                .ok_or_else(|| AppError::Database("MockReadRepo: sidebar_data not set".into()))
        }
        fn export_words_csv(&self) -> Result<String, AppError> {
            self.csv_export
                .clone()
                .ok_or_else(|| AppError::Export("MockReadRepo: csv_export not set".into()))
        }
        fn export_words_anki(&self) -> Result<String, AppError> {
            self.anki_export
                .clone()
                .ok_or_else(|| AppError::Export("MockReadRepo: anki_export not set".into()))
        }
    }

    /// 写 mock —— 继承 MockReadRepo 的读能力，写操作可通过 write_succeeds 控制成败。
    ///
    /// 字段捕获：每个 `last_*` 字段记录最近一次写操作的入参，测试中可断言写入内容。
    /// 错误注入：设置 `review_error` 可使 `calculate_and_update_review` 返回指定错误。
    pub(crate) struct MockWriteRepo {
        pub read: MockReadRepo,
        pub write_succeeds: bool,
        // ── 写入捕获 ──
        pub last_added_model: Option<NewModelInput>,
        pub last_review_update: Option<(i64, FsrsCard, FsrsRating)>,
        pub last_setting: Option<(String, String)>,
        pub last_word: Option<NewWordInput>,
        pub last_history: Option<(String, String, String, Option<String>)>,
        pub last_activity: Option<(String, LearningActivity)>,
        pub last_goal: Option<(String, i64)>,
        // ── 错误注入 ──
        pub review_error: Option<AppError>,
    }

    impl MockWriteRepo {
        pub(crate) fn new(read: MockReadRepo) -> Self {
            Self {
                read,
                write_succeeds: true,
                last_added_model: None,
                last_review_update: None,
                last_setting: None,
                last_word: None,
                last_history: None,
                last_activity: None,
                last_goal: None,
                review_error: None,
            }
        }
    }

    impl ReadRepository for MockWriteRepo {
        fn get_models(&self) -> Result<Vec<ModelDto>, AppError> {
            self.read.get_models()
        }
        fn get_default_model(&self) -> Result<Option<ModelDto>, AppError> {
            self.read.get_default_model()
        }
        fn get_first_model(&self) -> Result<Option<ModelDto>, AppError> {
            self.read.get_first_model()
        }
        fn get_model_api_key(&self, id: i64) -> String {
            self.read.get_model_api_key(id)
        }
        fn get_words(
            &self,
            limit: Option<i64>,
            offset: Option<i64>,
        ) -> Result<Vec<WordDto>, AppError> {
            self.read.get_words(limit, offset)
        }
        fn get_review_stats(&self) -> Result<ReviewStatsDto, AppError> {
            self.read.get_review_stats()
        }
        fn get_review_words(&self, limit: i64) -> Result<Vec<WordDto>, AppError> {
            self.read.get_review_words(limit)
        }
        fn get_history(
            &self,
            t: Option<&[&str]>,
            l: Option<i64>,
            o: Option<i64>,
        ) -> Result<Vec<HistoryDto>, AppError> {
            self.read.get_history(t, l, o)
        }
        fn get_history_list(
            &self,
            t: Option<&[&str]>,
            l: Option<i64>,
            o: Option<i64>,
        ) -> Result<Vec<HistoryDto>, AppError> {
            self.read.get_history_list(t, l, o)
        }
        fn get_history_by_id(&self, id: i64) -> Result<Option<HistoryDto>, AppError> {
            self.read.get_history_by_id(id)
        }
        fn get_recent_correct_results(&self, m: i64) -> Result<Vec<String>, AppError> {
            self.read.get_recent_correct_results(m)
        }
        fn get_history_oldest_date(&self) -> Result<Option<String>, AppError> {
            self.read.get_history_oldest_date()
        }
        fn get_history_results_by_type(
            &self,
            record_types: &[&str],
            limit: i64,
        ) -> Result<Vec<HistoryResultDto>, AppError> {
            self.read.get_history_results_by_type(record_types, limit)
        }
        fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
            self.read.get_setting(key)
        }
        fn get_tts_settings(&self) -> Result<(String, String, String, String), AppError> {
            self.read.get_tts_settings()
        }
        fn get_all_streaks(&self) -> Result<Vec<StreakRowDto>, AppError> {
            self.read.get_all_streaks()
        }
        fn get_learning_goals(&self) -> Result<Vec<GoalDto>, AppError> {
            self.read.get_learning_goals()
        }
        fn get_sidebar_data(&self, d: &str) -> Result<SidebarDataDto, AppError> {
            self.read.get_sidebar_data(d)
        }
        fn export_words_csv(&self) -> Result<String, AppError> {
            self.read.export_words_csv()
        }
        fn export_words_anki(&self) -> Result<String, AppError> {
            self.read.export_words_anki()
        }
    }

    impl WriteRepository for MockWriteRepo {
        fn add_model(&mut self, model: &NewModelInput) -> Result<i64, AppError> {
            if !self.write_succeeds {
                return Err(AppError::Database("mock write failed".into()));
            }
            self.last_added_model = Some(NewModelInput {
                name: model.name.clone(),
                api_key: model.api_key.clone(),
                base_url: model.base_url.clone(),
                model_name: model.model_name.clone(),
                is_default: model.is_default,
            });
            Ok(1)
        }
        fn update_model(
            &mut self,
            _id: i64,
            _n: &str,
            _b: &str,
            _m: &str,
            _k: &str,
            _d: bool,
        ) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn delete_model(&self, _id: i64) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn set_default_model(&self, _id: i64) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn add_word(&self, _input: &NewWordInput) -> Result<i64, AppError> {
            if self.write_succeeds {
                Ok(1)
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn delete_word(&self, _id: i64) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn update_word_level(&self, _id: i64, _l: &str) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn update_word_enrichment(
            &self,
            _i: i64,
            _p: &str,
            _d: &str,
            _n: &str,
        ) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn calculate_and_update_review(
            &self,
            id: i64,
            card: &FsrsCard,
            rating: FsrsRating,
        ) -> Result<ReviewCalcResult, AppError> {
            if let Some(err) = &self.review_error {
                return Err(AppError::Database(format!("mock: {err}")));
            }
            // Return a deterministic result based on the input card.
            // No embedded FSRS algorithm — tests assert on the call args, not the result.
            let new_reps = card.reps + 1;
            let status = if matches!(rating, FsrsRating::Easy) {
                "mastered".to_string()
            } else {
                "learning".to_string()
            };
            Ok(ReviewCalcResult {
                status,
                interval: 2,
                next_review_at: "2026-08-01 00:00:00".to_string(),
                card: FsrsCard {
                    stability: card.stability.max(0.4),
                    difficulty: card.difficulty,
                    elapsed_days: 0,
                    scheduled_days: 2,
                    reps: new_reps,
                    lapses: if matches!(rating, FsrsRating::Again) {
                        card.lapses + 1
                    } else {
                        card.lapses
                    },
                    state: FsrsState::Review,
                },
            })
        }
        fn add_history(
            &self,
            _t: &str,
            _i: &str,
            _r: &str,
            _g: Option<&str>,
        ) -> Result<i64, AppError> {
            if self.write_succeeds {
                Ok(1)
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn delete_history(&self, _id: i64) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn update_history_graph_data(&self, _id: i64, _g: &str) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn set_setting(&self, _k: &str, _v: &str) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn record_learning_activity(&self, _d: &str, _a: LearningActivity) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn set_learning_goal(&self, _t: &str, _v: i64) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Database("mock write failed".into()))
            }
        }
        fn backup_db(&self, _p: &str) -> Result<(), AppError> {
            if self.write_succeeds {
                Ok(())
            } else {
                Err(AppError::Export("mock backup failed".into()))
            }
        }
    }
}
