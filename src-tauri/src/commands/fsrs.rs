/// FSRS (Free Spaced Repetition Scheduler) commands.
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::fsrs;
use crate::repository;

use super::shared::with_db;

#[tauri::command]
pub async fn calculate_next_review(
    input: fsrs::ReviewCalcInput,
) -> Result<fsrs::ReviewCalcResult, AppError> {
    Ok(fsrs::calculate_next_review(input))
}

/// P3-8: 入参重构为 FsrsReviewUpdate struct，替代原先 12 个独立参数。
#[tauri::command]
pub async fn db_update_word_review_fsrs(
    db: State<'_, Db>,
    input: fsrs::FsrsReviewUpdate,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::update_word_review_fsrs(conn, &input)
    })
}
