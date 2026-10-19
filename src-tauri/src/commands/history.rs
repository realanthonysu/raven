//! 学习历史记录 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_history` - 新增历史记录
//! - `db_get_history_list` - 轻量级历史列表（不含 result/graph_data）
//! - `db_get_history_by_id` - 按 ID 查询单条记录（含 result，不含 graph_data）
//! - `db_get_history_graph_data` - 按 ID 单独读取知识图谱 JSON
//! - `db_delete_history` - 删除记录
//! - `db_update_history_graph_data` - 更新图表数据
//! - `db_get_recent_correct_results` - 查询最近的纠错记录
//! - `db_get_history_results_by_type` - 按类型批量查询结果文本（轻量，按 id 配对）
//! - `db_get_history_oldest_date` - 查询最早一条记录的时间戳

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::history;

use super::shared::{HistoryDto, HistoryResultDto, with_db, with_db_read};

// ============================================================================
// Core logic — 可独立测试的业务逻辑
// ============================================================================

/// 将 `Vec<String>` 类型过滤转换为 `Vec<&str>` 后查询轻量级历史列表。
pub fn query_history_list_typed(
    conn: &rusqlite::Connection,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    let types: Option<Vec<&str>> = record_types
        .as_ref()
        .map(|v| v.iter().map(String::as_str).collect());
    history::get_history_list(conn, types.as_deref(), limit, offset)
}

// ============================================================================
// Tauri Command handlers — 薄委托层
// ============================================================================

/// 新增一条学习历史记录。
///
/// # Arguments
///
/// * `record_type` - 记录类型（`"correct"` / `"writing"` 等）
/// * `input_text` - 用户输入的原始文本
/// * `result` - LLM 返回的结果
/// * `graph_data` - 可选的图表数据 JSON
/// * `difficulty_level` - 可选的 CEFR 级别码（A2..C1），标记本次练习难度档
#[tauri::command]
pub async fn db_add_history(
    db: State<'_, Db>,
    record_type: String,
    input_text: String,
    result: String,
    graph_data: Option<String>,
    difficulty_level: Option<String>,
) -> Result<i64, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| history::add_history(
        conn,
        &record_type,
        &input_text,
        &result,
        graph_data.as_deref(),
        difficulty_level.as_deref(),
    ))
}

/// Lightweight history list query for the HistoryPage list view.
/// Excludes the heavy `result` and `graph_data` columns that can be very large.
#[tauri::command]
pub async fn db_get_history_list(
    db: State<'_, Db>,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        query_history_list_typed(conn, record_types, limit, offset)
    })
}

/// 根据 ID 查询单条历史记录详情（含 result，不含 graph_data）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
#[tauri::command]
pub async fn db_get_history_by_id(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        history::get_history_by_id(conn, id)
    })
}

/// 按 ID 单独读取知识图谱 JSON（阅读详情专用）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
#[tauri::command]
pub async fn db_get_history_graph_data(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<String>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        history::get_history_graph_data(conn, id)
    })
}

/// 删除指定历史记录。
///
/// # Arguments
///
/// * `id` - 要删除的记录 ID
#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| history::delete_history(
        conn, id
    ))
}

/// 更新历史记录的图表数据（LLM 流式完成后异步回写）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
/// * `graph_data` - 图表数据 JSON 字符串
#[tauri::command]
pub async fn db_update_history_graph_data(
    db: State<'_, Db>,
    id: i64,
    graph_data: String,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        history::update_history_graph_data(conn, id, &graph_data)
    })
}

/// Query recent correction records for the frontend's buildPersonalizedContext.
#[tauri::command]
pub async fn db_get_recent_correct_results(
    db: State<'_, Db>,
    max_records: i64,
) -> Result<Vec<String>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        history::get_recent_correct_results(conn, max_records)
    })
}

/// 查询最早历史记录的创建时间（Dashboard 计算使用天数）。
#[tauri::command]
pub async fn db_get_history_oldest_date(db: State<'_, Db>) -> Result<Option<String>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        history::get_history_oldest_date(conn)
    })
}

/// 按类型集合查询历史记录的 (id, result) 对（AnalyticsPage 按需获取）。
///
/// 返回 id 让前端与轻量记录列表按 id 精确配对，替代此前依赖返回顺序的
/// 按下标配对（P0 修复：混入 legacy "writing" 类型或两次查询间隙插入新记录时会错位）。
///
/// # Arguments
///
/// * `record_types` - 记录类型列表（如 `["correct", "writing"]` 兼容历史数据两种 type 值）
/// * `limit` - 最大返回条数
#[tauri::command]
pub async fn db_get_history_results_by_type(
    db: State<'_, Db>,
    record_types: Vec<String>,
    limit: i64,
) -> Result<Vec<HistoryResultDto>, AppError> {
    // spawn_blocking 闭包是 'static：借用无法跨闭包边界，
    // 因此把类型列表转为自有 String 后再 move 进闭包
    let types: Vec<String> = record_types.clone();
    with_db_read!(db, |conn: &rusqlite::Connection| {
        let type_refs: Vec<&str> = types.iter().map(String::as_str).collect();
        history::get_history_results_by_type(conn, &type_refs, limit)
    })
}

// ============================================================================
// Unit tests — 内存数据库上的核心逻辑测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;

    /// 插入一条历史记录，返回记录 ID。
    fn insert_history(conn: &rusqlite::Connection, record_type: &str, input_text: &str) -> i64 {
        history::add_history(conn, record_type, input_text, "result", None, None).unwrap()
    }

    #[test]
    fn query_history_list_typed_excludes_heavy_columns() {
        let conn = create_test_db();
        let id = insert_history(&conn, "correct", "a");

        let result =
            query_history_list_typed(&conn, Some(vec!["correct".into()]), Some(5), Some(0))
                .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, id);
        // 轻量查询将 result 置空、graph_data 置 NULL
        assert_eq!(result[0].result, "");
        assert_eq!(result[0].graph_data, None);
    }

    #[test]
    fn query_history_list_typed_none_types_returns_all() {
        let conn = create_test_db();
        insert_history(&conn, "correct", "a");
        insert_history(&conn, "speaking", "b");

        let result = query_history_list_typed(&conn, None, None, None).unwrap();
        assert_eq!(result.len(), 2);
    }
}
