//! 学习打卡与目标管理。

use rusqlite::params;

use crate::commands::shared::{GoalDto, LearningActivity, SidebarDataDto, StreakRowDto};
use crate::error::AppError;

use super::validate_goal_type;

/// 记录一次学习活动（打卡）。
///
/// 使用 JSON 函数在 `learning_streaks` 表中累计指定日期的活动次数。
/// 同一日期同一活动类型会累加计数。
///
/// # Arguments
///
/// * `date` - 日期字符串（YYYY-MM-DD 格式）
/// * `activity` - 学习活动类型
pub fn record_learning_activity(
    conn: &rusqlite::Connection,
    date: &str,
    activity: LearningActivity,
) -> Result<(), AppError> {
    let key = activity.as_str();
    conn.execute(
        "INSERT INTO learning_streaks (date, activities) VALUES (?1, json_set('{}', '$.' || ?2, 1)) ON CONFLICT(date) DO UPDATE SET activities = json_set(COALESCE(activities, '{}'), '$.' || ?2, COALESCE(json_extract(activities, '$.' || ?2), 0) + 1)",
        params![date, key],
    )?;
    Ok(())
}

/// 查询所有学习打卡记录（按日期倒序）。
///
/// # Returns
///
/// 每行包含日期和活动 JSON（如 `{"writing": 3, "review": 5}`）。
pub fn get_all_streaks(conn: &rusqlite::Connection) -> Result<Vec<StreakRowDto>, AppError> {
    let mut stmt =
        conn.prepare("SELECT date, activities FROM learning_streaks ORDER BY date DESC")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StreakRowDto {
                date: row.get("date")?,
                activities: row.get("activities")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
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
pub fn get_today_activities(
    conn: &rusqlite::Connection,
    date: &str,
) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT activities FROM learning_streaks WHERE date = ?1")?;
    let val = stmt
        .query_map(params![date], |row| row.get::<_, String>("activities"))?
        .next()
        .transpose()?;
    Ok(val)
}

/// 查询所有学习目标。
///
/// # Returns
///
/// 目标列表，每项包含目标类型和目标值。
pub fn get_learning_goals(conn: &rusqlite::Connection) -> Result<Vec<GoalDto>, AppError> {
    let mut stmt = conn.prepare("SELECT goal_type, target FROM learning_goals")?;
    let goals = stmt
        .query_map([], |row| {
            Ok(GoalDto {
                goal_type: row.get("goal_type")?,
                target: row.get("target")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(goals)
}

/// 设置/更新学习目标（Upsert 语义）。
///
/// # Arguments
///
/// * `goal_type` - 目标类型（`"review"` / `"exercise"` / `"reading"` 等，经白名单校验）
/// * `target` - 目标值（如每日复习 20 个单词）
pub fn set_learning_goal(
    conn: &rusqlite::Connection,
    goal_type: &str,
    target: i64,
) -> Result<(), AppError> {
    validate_goal_type(goal_type)?;
    conn.execute(
        "INSERT INTO learning_goals (goal_type, target) VALUES (?1, ?2) ON CONFLICT(goal_type) DO UPDATE SET target = ?2",
        params![goal_type, target],
    )?;
    Ok(())
}

/// L-10: 聚合 Sidebar 所需数据（复习统计 + 连续天数 + 目标 + 今日活动）。
/// 将 4 次独立查询合并为 1 次，减少前端 IPC 调用次数。
pub fn get_sidebar_data(
    conn: &rusqlite::Connection,
    today_date: &str,
) -> Result<SidebarDataDto, AppError> {
    let review_stats = super::words::get_review_stats(conn)?;

    // 计算连续学习天数（使用前端传入的 today_date，确保时区一致）
    let today = chrono::NaiveDate::parse_from_str(today_date, "%Y-%m-%d")
        .unwrap_or_else(|_| chrono::Local::now().date_naive());
    let streak_rows = get_all_streaks(conn)?;
    let mut streak: i64 = 0;
    for (i, row) in streak_rows.iter().enumerate() {
        let expected = (today - chrono::Duration::days(i as i64))
            .format("%Y-%m-%d")
            .to_string();
        if row.date == expected {
            streak += 1;
        } else {
            break;
        }
    }

    let goals = get_learning_goals(conn)?;
    let today_activities = get_today_activities(conn, today_date)?;

    Ok(SidebarDataDto {
        review_stats,
        streak,
        goals,
        today_activities,
    })
}
