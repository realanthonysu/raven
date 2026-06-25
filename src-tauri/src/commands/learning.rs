/// Learning activity, streaks, and goals commands.
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, GoalDto, LearningActivity, StreakRowDto};

#[tauri::command]
pub async fn db_record_learning_activity(
    db: State<'_, Db>,
    date: String,
    activity: LearningActivity,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::record_learning_activity(conn, &date, activity)
    })
}

#[tauri::command]
pub async fn db_get_all_streaks(db: State<'_, Db>) -> Result<Vec<StreakRowDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_all_streaks(conn)
    })
}

#[tauri::command]
pub async fn db_get_today_activities(
    db: State<'_, Db>,
    date: String,
) -> Result<Option<String>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_today_activities(conn, &date)
    })
}

#[tauri::command]
pub async fn db_get_learning_goals(db: State<'_, Db>) -> Result<Vec<GoalDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_learning_goals(conn)
    })
}

#[tauri::command]
pub async fn db_set_learning_goal(
    db: State<'_, Db>,
    goal_type: String,
    target: i64,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::set_learning_goal(conn, &goal_type, target)
    })
}
