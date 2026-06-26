//! FSRS 间隔重复算法 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `calculate_next_review` - 根据卡片状态和评分计算下次复习调度
//! - `db_update_word_review_fsrs` - 使用 FSRS 算法结果更新单词的复习状态

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::fsrs;
use crate::repository;

use super::shared::with_db;

/// 根据当前卡片状态和用户评分，计算下次复习的调度结果。
///
/// 纯计算 Command（不涉及数据库），返回更新后的卡片状态、
/// 间隔天数和下次复习日期。
///
/// # Arguments
///
/// * `input` - 包含卡片状态和评分的输入
///
/// # Returns
///
/// FSRS 调度结果（状态标签、间隔、下次复习时间、更新后的卡片）。
#[tauri::command]
pub async fn calculate_next_review(
    input: fsrs::ReviewCalcInput,
) -> Result<fsrs::ReviewCalcResult, AppError> {
    Ok(fsrs::calculate_next_review(input))
}

/// 使用 FSRS 算法结果更新单词的完整复习状态（含 FSRS 卡片参数）。
///
/// P3-8: 入参重构为 FsrsReviewUpdate struct，替代原先 12 个独立参数。
///
/// # Arguments
///
/// * `input` - 包含单词 ID、学习状态、复习次数、下次复习时间和 FSRS 卡片状态
#[tauri::command]
pub async fn db_update_word_review_fsrs(
    db: State<'_, Db>,
    input: fsrs::FsrsReviewUpdate,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::update_word_review_fsrs(conn, &input)
    })
}
