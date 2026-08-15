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
    // M-3: 校验日期格式为 YYYY-MM-DD，防止非法数据入库
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return Err(AppError::Database(format!(
            "invalid date format: '{date}', expected YYYY-MM-DD"
        )));
    }
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
    // M-2: 限制查询最近 365 天，防止长期用户全量加载导致 OOM
    let mut stmt =
        conn.prepare("SELECT date, activities FROM learning_streaks ORDER BY date DESC LIMIT 365")?;
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
    // M-4: 目标值必须为正数，防止除零或异常百分比
    if target <= 0 {
        return Err(AppError::Database(format!(
            "goal target must be positive, got {target}"
        )));
    }
    conn.execute(
        "INSERT INTO learning_goals (goal_type, target) VALUES (?1, ?2) ON CONFLICT(goal_type) DO UPDATE SET target = ?2",
        params![goal_type, target],
    )?;
    Ok(())
}

/// 从打卡记录中计算连续学习天数。
///
/// 纯函数，不执行任何 I/O。从 `today` 开始向前遍历 `streaks`，
/// 遇到第一个缺失日期则停止计数。
///
/// # Arguments
///
/// * `today` - 当前日期（由调用方注入，确保时区一致且可测试）
/// * `streaks` - 按日期倒序排列的打卡记录
///
/// # Returns
///
/// 连续学习天数（0 表示今天未学习或无打卡记录）
pub fn compute_learning_streak(today: chrono::NaiveDate, streaks: &[StreakRowDto]) -> i64 {
    let mut streak: i64 = 0;
    for (i, row) in streaks.iter().enumerate() {
        let expected = (today - chrono::Duration::days(i as i64))
            .format("%Y-%m-%d")
            .to_string();
        if row.date == expected {
            streak += 1;
        } else {
            break;
        }
    }
    streak
}

/// L-10: 聚合 Sidebar 所需数据（复习统计 + 连续天数 + 目标 + 今日活动）。
/// 将 4 次独立查询合并为 1 次，减少前端 IPC 调用次数。
pub fn get_sidebar_data(
    conn: &rusqlite::Connection,
    today_date: &str,
) -> Result<SidebarDataDto, AppError> {
    let review_stats = super::words::get_review_stats(conn)?;

    // 计算连续学习天数（使用前端传入的 today_date，确保时区一致）。
    // 解析失败时回退本地日期,且后续 activities 查询必须使用同一日期字符串——
    // 此前 streak 回退而 activities 仍用原始非法串,两者口径不一致
    let effective_today = chrono::NaiveDate::parse_from_str(today_date, "%Y-%m-%d")
        .unwrap_or_else(|_| chrono::Local::now().date_naive());
    let effective_today_str = effective_today.format("%Y-%m-%d").to_string();
    let streak_rows = get_all_streaks(conn)?;
    let streak = compute_learning_streak(effective_today, &streak_rows);

    let goals = get_learning_goals(conn)?;
    let today_activities = get_today_activities(conn, &effective_today_str)?;

    Ok(SidebarDataDto {
        review_stats,
        streak,
        goals,
        today_activities,
    })
}

// ============================================================================
// Unit tests — compute_learning_streak 纯函数
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_streak_row(date: &str) -> StreakRowDto {
        StreakRowDto {
            date: date.to_string(),
            activities: "{}".to_string(),
        }
    }

    #[test]
    fn streak_empty_rows_returns_zero() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        assert_eq!(compute_learning_streak(today, &[]), 0);
    }

    #[test]
    fn streak_consecutive_days_from_today() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        let rows = vec![
            make_streak_row("2026-07-23"),
            make_streak_row("2026-07-22"),
            make_streak_row("2026-07-21"),
        ];
        assert_eq!(compute_learning_streak(today, &rows), 3);
    }

    #[test]
    fn streak_breaks_at_first_gap() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        let rows = vec![
            make_streak_row("2026-07-23"),
            make_streak_row("2026-07-22"),
            // gap: 2026-07-21 missing
            make_streak_row("2026-07-20"),
        ];
        assert_eq!(compute_learning_streak(today, &rows), 2);
    }

    #[test]
    fn streak_zero_when_today_missing() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        let rows = vec![make_streak_row("2026-07-22"), make_streak_row("2026-07-21")];
        assert_eq!(compute_learning_streak(today, &rows), 0);
    }

    #[test]
    fn streak_single_day_today() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        let rows = vec![make_streak_row("2026-07-23")];
        assert_eq!(compute_learning_streak(today, &rows), 1);
    }

    #[test]
    fn streak_ignores_future_dates() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 23).unwrap();
        // Row has tomorrow's date — doesn't match today, streak = 0
        let rows = vec![make_streak_row("2026-07-24")];
        assert_eq!(compute_learning_streak(today, &rows), 0);
    }

    #[test]
    fn streak_month_boundary() {
        // Test across month boundary: July 1 → June 30 → June 29
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        let rows = vec![
            make_streak_row("2026-07-01"),
            make_streak_row("2026-06-30"),
            make_streak_row("2026-06-29"),
        ];
        assert_eq!(compute_learning_streak(today, &rows), 3);
    }
}

// ============================================================================
// Integration tests — 使用 create_test_db() 测试学习打卡、目标与 Sidebar 聚合
// ============================================================================

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::commands::shared::NewWordInput;
    use crate::db::create_test_db;
    use crate::repository::words::add_word;

    fn make_word(word: &str) -> NewWordInput {
        NewWordInput {
            word: word.to_string(),
            phonetic: None,
            definition: format!("definition of {word}"),
            level: None,
            source_type: None,
            source_text: None,
            notes: None,
            review_status: None,
        }
    }

    // ── record_learning_activity + get_today_activities ──

    #[test]
    fn record_activity_then_get_today() {
        let conn = create_test_db();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Writing).unwrap();
        let activities = get_today_activities(&conn, "2026-07-25").unwrap();
        assert!(activities.is_some());
        let json: serde_json::Value = serde_json::from_str(&activities.unwrap()).unwrap();
        assert_eq!(json["writing"], 1);
    }

    #[test]
    fn record_activity_increments_existing() {
        let conn = create_test_db();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Review).unwrap();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Review).unwrap();
        let activities = get_today_activities(&conn, "2026-07-25").unwrap();
        let json: serde_json::Value = serde_json::from_str(&activities.unwrap()).unwrap();
        assert_eq!(json["review"], 2);
    }

    #[test]
    fn record_activity_multiple_types() {
        let conn = create_test_db();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Writing).unwrap();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Review).unwrap();
        let activities = get_today_activities(&conn, "2026-07-25").unwrap();
        let json: serde_json::Value = serde_json::from_str(&activities.unwrap()).unwrap();
        assert_eq!(json["writing"], 1);
        assert_eq!(json["review"], 1);
    }

    #[test]
    fn record_activity_rejects_invalid_date() {
        let conn = create_test_db();
        let result = record_learning_activity(&conn, "not-a-date", LearningActivity::Writing);
        assert!(result.is_err());
    }

    // ── set_learning_goal / get_learning_goals ──

    #[test]
    fn set_goal_then_get() {
        let conn = create_test_db();
        set_learning_goal(&conn, "review", 20).unwrap();
        let goals = get_learning_goals(&conn).unwrap();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].goal_type, "review");
        assert_eq!(goals[0].target, 20);
    }

    #[test]
    fn set_goal_upserts() {
        let conn = create_test_db();
        set_learning_goal(&conn, "review", 20).unwrap();
        set_learning_goal(&conn, "review", 30).unwrap();
        let goals = get_learning_goals(&conn).unwrap();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].target, 30);
    }

    #[test]
    fn set_goal_multiple_types() {
        let conn = create_test_db();
        set_learning_goal(&conn, "review", 20).unwrap();
        set_learning_goal(&conn, "exercise", 10).unwrap();
        let goals = get_learning_goals(&conn).unwrap();
        assert_eq!(goals.len(), 2);
    }

    #[test]
    fn set_goal_rejects_invalid_type() {
        let conn = create_test_db();
        let result = set_learning_goal(&conn, "invalid_goal", 10);
        assert!(result.is_err());
    }

    // ── get_all_streaks ──

    #[test]
    fn get_all_streaks_returns_reverse_chronological() {
        let conn = create_test_db();
        record_learning_activity(&conn, "2026-07-23", LearningActivity::Writing).unwrap();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Review).unwrap();
        record_learning_activity(&conn, "2026-07-24", LearningActivity::Writing).unwrap();
        let streaks = get_all_streaks(&conn).unwrap();
        assert_eq!(streaks.len(), 3);
        assert_eq!(streaks[0].date, "2026-07-25");
        assert_eq!(streaks[1].date, "2026-07-24");
        assert_eq!(streaks[2].date, "2026-07-23");
    }

    // ── get_sidebar_data ──

    #[test]
    fn sidebar_data_empty_db() {
        let conn = create_test_db();
        let data = get_sidebar_data(&conn, "2026-07-25").unwrap();
        assert_eq!(data.review_stats.total, 0);
        assert_eq!(data.streak, 0);
        assert!(data.goals.is_empty());
        assert!(data.today_activities.is_none());
    }

    #[test]
    fn sidebar_data_with_data() {
        let conn = create_test_db();
        add_word(&conn, &make_word("hello")).unwrap();
        add_word(&conn, &make_word("world")).unwrap();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Writing).unwrap();
        set_learning_goal(&conn, "review", 20).unwrap();

        let data = get_sidebar_data(&conn, "2026-07-25").unwrap();
        assert_eq!(data.review_stats.total, 2);
        assert_eq!(data.streak, 1);
        assert_eq!(data.goals.len(), 1);
        assert!(data.today_activities.is_some());
    }

    #[test]
    fn sidebar_data_computes_streak() {
        let conn = create_test_db();
        record_learning_activity(&conn, "2026-07-23", LearningActivity::Writing).unwrap();
        record_learning_activity(&conn, "2026-07-24", LearningActivity::Writing).unwrap();
        record_learning_activity(&conn, "2026-07-25", LearningActivity::Writing).unwrap();

        let data = get_sidebar_data(&conn, "2026-07-25").unwrap();
        assert_eq!(data.streak, 3);
    }
}
