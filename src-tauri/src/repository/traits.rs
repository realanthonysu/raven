//! Repository trait 抽象层 —— 为数据访问提供可替换的接口。
//!
//! 定义 [`ReadRepository`]（只读操作）和 [`WriteRepository`]（写操作）两个 trait，
//! 并为 `rusqlite::Connection` 提供委托给现有自由函数的默认实现。
//!
//! ## 设计动机
//!
//! 自由函数形式的 Repository 无法在 Command 层做单元测试时 mock，
//! 也无法替换实现（如测试用内存数据库）。Trait 抽象使得：
//! - Command 层可以通过泛型 `<R: ReadRepository>` 接受任意实现
//! - 测试中可以提供 mock 实现替代真实数据库
//! - 未来可扩展为其他存储后端
//!
//! ## 使用方式
//!
//! 当前 Command 层仍直接调用自由函数（`repository::get_models(conn)`）。
//! 后续可逐步迁移到 trait 方法调用（`conn.get_models()`），此过程不改变 API 契约。
//!
//! ```ignore
//! // 未来 Command 层用法：
//! fn db_get_models<R: ReadRepository>(repo: &R) -> Result<Vec<ModelDto>, AppError> {
//!     repo.get_models()
//! }
//! ```

use crate::commands::shared::*;
use crate::error::AppError;
use crate::fsrs::{FsrsCard, FsrsRating, FsrsReviewUpdate, ReviewCalcResult};

// ============================================================================
// ReadRepository — 只读操作（SELECT）
// ============================================================================

/// 只读数据访问 trait。覆盖所有 SELECT 操作。
///
/// `rusqlite::Connection` 已实现此 trait，委托给 `repository::*` 自由函数。
/// 测试中可提供 mock 实现。
#[allow(dead_code)] // Trait 定义供 Command 层逐步迁移使用，当前通过自由函数调用
pub trait ReadRepository {
    // ── Models ──
    fn get_models(&self) -> Result<Vec<ModelDto>, AppError>;
    fn get_default_model(&self) -> Result<Option<ModelDto>, AppError>;
    fn get_first_model(&self) -> Result<Option<ModelDto>, AppError>;

    // ── Words ──
    fn get_words(&self) -> Result<Vec<WordDto>, AppError>;
    fn get_review_stats(&self) -> Result<ReviewStatsDto, AppError>;
    fn get_review_words(&self, limit: i64) -> Result<Vec<WordDto>, AppError>;

    // ── History ──
    fn get_history(
        &self,
        record_types: Option<&[&str]>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<HistoryDto>, AppError>;
    fn get_history_list(
        &self,
        record_types: Option<&[&str]>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<HistoryDto>, AppError>;
    fn get_history_by_id(&self, id: i64) -> Result<Option<HistoryDto>, AppError>;
    fn get_recent_correct_results(&self, max_records: i64) -> Result<Vec<String>, AppError>;

    // ── Settings ──
    fn get_setting(&self, key: &str) -> Result<Option<String>, AppError>;
    fn get_tts_settings(&self) -> Result<(String, String, String, String), AppError>;

    // ── Learning ──
    fn get_all_streaks(&self) -> Result<Vec<StreakRowDto>, AppError>;
    fn get_today_activities(&self, date: &str) -> Result<Option<String>, AppError>;
    fn get_learning_goals(&self) -> Result<Vec<GoalDto>, AppError>;
    fn get_sidebar_data(&self, today_date: &str) -> Result<SidebarDataDto, AppError>;

    // ── Export ──
    fn export_words_csv(&self) -> Result<String, AppError>;
    fn export_words_anki(&self) -> Result<String, AppError>;
}

// ============================================================================
// WriteRepository — 写操作（INSERT / UPDATE / DELETE）
// ============================================================================

/// 写数据访问 trait。覆盖所有 INSERT / UPDATE / DELETE 操作。
///
/// 继承 `ReadRepository`，因为写操作的调用方通常也需要读取能力。
/// 需要 `&mut self` 的方法（如事务操作）使用可变引用。
#[allow(dead_code)] // Trait 定义供 Command 层逐步迁移使用，当前通过自由函数调用
pub trait WriteRepository: ReadRepository {
    // ── Models（需要 &mut self 的事务操作） ──
    fn add_model(&mut self, model: &NewModelInput) -> Result<i64, AppError>;
    fn update_model(
        &mut self,
        id: i64,
        name: &str,
        base_url: &str,
        model_name: &str,
        api_key: &str,
        is_default: bool,
    ) -> Result<(), AppError>;

    // ── Models（&self 即可的操作） ──
    fn delete_model(&self, id: i64) -> Result<(), AppError>;
    fn set_default_model(&self, id: i64) -> Result<(), AppError>;

    // ── Words ──
    fn add_word(&self, input: &NewWordInput) -> Result<i64, AppError>;
    fn delete_word(&self, id: i64) -> Result<(), AppError>;
    fn update_word_level(&self, id: i64, level: &str) -> Result<(), AppError>;
    fn update_word_enrichment(
        &self,
        id: i64,
        phonetic: &str,
        definition: &str,
        notes: &str,
    ) -> Result<(), AppError>;
    fn calculate_and_update_review(
        &self,
        id: i64,
        card: &FsrsCard,
        rating: FsrsRating,
    ) -> Result<ReviewCalcResult, AppError>;
    fn update_word_review_fsrs(&self, input: &FsrsReviewUpdate) -> Result<(), AppError>;

    // ── History ──
    fn add_history(
        &self,
        record_type: &str,
        input_text: &str,
        result: &str,
        graph_data: Option<&str>,
    ) -> Result<i64, AppError>;
    fn delete_history(&self, id: i64) -> Result<(), AppError>;
    fn update_history_graph_data(&self, id: i64, graph_data: &str) -> Result<(), AppError>;

    // ── Settings ──
    fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError>;

    // ── Learning ──
    fn record_learning_activity(
        &self,
        date: &str,
        activity: LearningActivity,
    ) -> Result<(), AppError>;
    fn set_learning_goal(&self, goal_type: &str, target: i64) -> Result<(), AppError>;

    // ── Backup ──
    fn backup_db(&self, dest_path: &str) -> Result<(), AppError>;
}

// ============================================================================
// 实现：rusqlite::Connection 委托给现有自由函数
// ============================================================================

impl ReadRepository for rusqlite::Connection {
    fn get_models(&self) -> Result<Vec<ModelDto>, AppError> {
        super::models::get_models(self)
    }
    fn get_default_model(&self) -> Result<Option<ModelDto>, AppError> {
        super::models::get_default_model(self)
    }
    fn get_first_model(&self) -> Result<Option<ModelDto>, AppError> {
        super::models::get_first_model(self)
    }

    fn get_words(&self) -> Result<Vec<WordDto>, AppError> {
        super::words::get_words(self)
    }
    fn get_review_stats(&self) -> Result<ReviewStatsDto, AppError> {
        super::words::get_review_stats(self)
    }
    fn get_review_words(&self, limit: i64) -> Result<Vec<WordDto>, AppError> {
        super::words::get_review_words(self, limit)
    }

    fn get_history(
        &self,
        record_types: Option<&[&str]>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<HistoryDto>, AppError> {
        super::history::get_history(self, record_types, limit, offset)
    }
    fn get_history_list(
        &self,
        record_types: Option<&[&str]>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<HistoryDto>, AppError> {
        super::history::get_history_list(self, record_types, limit, offset)
    }
    fn get_history_by_id(&self, id: i64) -> Result<Option<HistoryDto>, AppError> {
        super::history::get_history_by_id(self, id)
    }
    fn get_recent_correct_results(&self, max_records: i64) -> Result<Vec<String>, AppError> {
        super::history::get_recent_correct_results(self, max_records)
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        super::settings::get_setting(self, key)
    }
    fn get_tts_settings(&self) -> Result<(String, String, String, String), AppError> {
        super::settings::get_tts_settings(self)
    }

    fn get_all_streaks(&self) -> Result<Vec<StreakRowDto>, AppError> {
        super::learning::get_all_streaks(self)
    }
    fn get_today_activities(&self, date: &str) -> Result<Option<String>, AppError> {
        super::learning::get_today_activities(self, date)
    }
    fn get_learning_goals(&self) -> Result<Vec<GoalDto>, AppError> {
        super::learning::get_learning_goals(self)
    }
    fn get_sidebar_data(&self, today_date: &str) -> Result<SidebarDataDto, AppError> {
        super::learning::get_sidebar_data(self, today_date)
    }

    fn export_words_csv(&self) -> Result<String, AppError> {
        super::export::export_words_csv(self)
    }
    fn export_words_anki(&self) -> Result<String, AppError> {
        super::export::export_words_anki(self)
    }
}

impl WriteRepository for rusqlite::Connection {
    fn add_model(&mut self, model: &NewModelInput) -> Result<i64, AppError> {
        super::models::add_model(self, model)
    }
    fn update_model(
        &mut self,
        id: i64,
        name: &str,
        base_url: &str,
        model_name: &str,
        api_key: &str,
        is_default: bool,
    ) -> Result<(), AppError> {
        super::models::update_model(self, id, name, base_url, model_name, api_key, is_default)
    }

    fn delete_model(&self, id: i64) -> Result<(), AppError> {
        super::models::delete_model(self, id)
    }
    fn set_default_model(&self, id: i64) -> Result<(), AppError> {
        super::models::set_default_model(self, id)
    }

    fn add_word(&self, input: &NewWordInput) -> Result<i64, AppError> {
        super::words::add_word(self, input)
    }
    fn delete_word(&self, id: i64) -> Result<(), AppError> {
        super::words::delete_word(self, id)
    }
    fn update_word_level(&self, id: i64, level: &str) -> Result<(), AppError> {
        super::words::update_word_level(self, id, level)
    }
    fn update_word_enrichment(
        &self,
        id: i64,
        phonetic: &str,
        definition: &str,
        notes: &str,
    ) -> Result<(), AppError> {
        super::words::update_word_enrichment(self, id, phonetic, definition, notes)
    }
    fn calculate_and_update_review(
        &self,
        id: i64,
        card: &FsrsCard,
        rating: FsrsRating,
    ) -> Result<ReviewCalcResult, AppError> {
        super::words::calculate_and_update_review(self, id, card, rating)
    }
    fn update_word_review_fsrs(&self, input: &FsrsReviewUpdate) -> Result<(), AppError> {
        super::words::update_word_review_fsrs(self, input)
    }

    fn add_history(
        &self,
        record_type: &str,
        input_text: &str,
        result: &str,
        graph_data: Option<&str>,
    ) -> Result<i64, AppError> {
        super::history::add_history(self, record_type, input_text, result, graph_data)
    }
    fn delete_history(&self, id: i64) -> Result<(), AppError> {
        super::history::delete_history(self, id)
    }
    fn update_history_graph_data(&self, id: i64, graph_data: &str) -> Result<(), AppError> {
        super::history::update_history_graph_data(self, id, graph_data)
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        super::settings::set_setting(self, key, value)
    }

    fn record_learning_activity(
        &self,
        date: &str,
        activity: LearningActivity,
    ) -> Result<(), AppError> {
        super::learning::record_learning_activity(self, date, activity)
    }
    fn set_learning_goal(&self, goal_type: &str, target: i64) -> Result<(), AppError> {
        super::learning::set_learning_goal(self, goal_type, target)
    }

    fn backup_db(&self, dest_path: &str) -> Result<(), AppError> {
        super::export::backup_db(self, dest_path)
    }
}
