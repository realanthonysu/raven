//! 学习打卡与目标管理 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_record_learning_activity` - 记录一次学习活动（打卡）
//! - `db_get_all_streaks` - 查询所有打卡记录
//! - `db_get_today_activities` - 查询今日活动
//! - `db_get_learning_goals` - 查询所有学习目标
//! - `db_set_learning_goal` - 设置/更新学习目标

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, GoalDto, LearningActivity, StreakRowDto};

/// 记录一次学习活动（打卡）。
///
/// 同一日期同一活动类型会累加计数。
///
/// # Arguments
///
/// * `date` - 日期字符串（YYYY-MM-DD 格式）
/// * `activity` - 学习活动类型（writing / reading / exercise / listening / review）
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

/// 查询所有学习打卡记录（按日期倒序）。
///
/// 用于日历热力图展示连续学习天数。
#[tauri::command]
pub async fn db_get_all_streaks(db: State<'_, Db>) -> Result<Vec<StreakRowDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_all_streaks(conn)
    })
}

/// 查询指定日期的学习活动记录。
///
/// # Arguments
///
/// * `date` - 日期字符串（YYYY-MM-DD 格式）
///
/// # Returns
///
/// 活动 JSON 字符串（如 `{"writing": 3}`），该日期无记录时返回 `None`。
#[tauri::command]
pub async fn db_get_today_activities(
    db: State<'_, Db>,
    date: String,
) -> Result<Option<String>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_today_activities(conn, &date)
    })
}

/// 查询所有学习目标。
///
/// 返回每种目标类型及其对应的每日目标值。
#[tauri::command]
pub async fn db_get_learning_goals(db: State<'_, Db>) -> Result<Vec<GoalDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_learning_goals(conn)
    })
}

/// 设置/更新学习目标（Upsert 语义）。
///
/// # Arguments
///
/// * `goal_type` - 目标类型（review / exercise / reading / writing / listening）
/// * `target` - 每日目标值
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
