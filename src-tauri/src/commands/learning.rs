//! 学习打卡与目标管理 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_record_learning_activity` - 记录一次学习活动（打卡）
//! - `db_get_all_streaks` - 查询所有打卡记录
//! - `db_get_learning_goals` - 查询所有学习目标
//! - `db_set_learning_goal` - 设置/更新学习目标
//! - `db_get_sidebar_data` - Sidebar 聚合数据（复习统计+连续天数+目标+今日活动）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::traits::{ReadRepository, WriteRepository};

use super::shared::{
    with_db, with_db_read, GoalDto, LearningActivity, SidebarDataDto, StreakRowDto,
};

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
        conn.record_learning_activity(&date, activity)
    })
}

/// 查询所有学习打卡记录（按日期倒序）。
///
/// 用于日历热力图展示连续学习天数。
#[tauri::command]
pub async fn db_get_all_streaks(db: State<'_, Db>) -> Result<Vec<StreakRowDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn.get_all_streaks())
}

/// 查询所有学习目标。
///
/// 返回每种目标类型及其对应的每日目标值。
#[tauri::command]
pub async fn db_get_learning_goals(db: State<'_, Db>) -> Result<Vec<GoalDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn.get_learning_goals())
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
        conn.set_learning_goal(&goal_type, target)
    })
}

/// L-10: 聚合 Sidebar 所需数据（复习统计 + 连续天数 + 目标 + 今日活动）。
///
/// 将 4 次独立 IPC 调用合并为 1 次，减少延迟和连接池竞争。
#[tauri::command]
pub async fn db_get_sidebar_data(
    db: State<'_, Db>,
    today_date: String,
) -> Result<SidebarDataDto, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn
        .get_sidebar_data(&today_date))
}
