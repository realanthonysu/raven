//! 学习历史记录 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_history` - 新增历史记录
//! - `db_get_history` - 查询历史记录（含完整字段）
//! - `db_get_history_list` - 轻量级历史列表（不含 result/graph_data）
//! - `db_get_history_by_id` - 按 ID 查询单条记录
//! - `db_delete_history` - 删除记录
//! - `db_update_history_graph_data` - 更新图表数据
//! - `db_get_recent_correct_results` - 查询最近的纠错记录

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, HistoryDto};

/// 新增一条学习历史记录。
///
/// # Arguments
///
/// * `record_type` - 记录类型（`"correct"` / `"writing"` 等）
/// * `input_text` - 用户输入的原始文本
/// * `result` - LLM 返回的结果
/// * `graph_data` - 可选的图表数据 JSON
#[tauri::command]
pub async fn db_add_history(
    db: State<'_, Db>,
    record_type: String,
    input_text: String,
    result: String,
    graph_data: Option<String>,
) -> Result<i64, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::add_history(
        conn,
        &record_type,
        &input_text,
        &result,
        graph_data.as_deref(),
    ))
}

/// 查询历史记录列表（含完整字段 result 和 graph_data）。
///
/// 支持按记录类型过滤和分页。
///
/// # Arguments
///
/// * `record_types` - 可选的类型过滤列表
/// * `limit` - 每页条数
/// * `offset` - 偏移量
#[tauri::command]
pub async fn db_get_history(
    db: State<'_, Db>,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let types: Option<Vec<&str>> = record_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        repository::get_history(conn, types.as_deref(), limit, offset)
    })
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
    with_db!(db, |conn: &rusqlite::Connection| {
        let types: Option<Vec<&str>> = record_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        repository::get_history_list(conn, types.as_deref(), limit, offset)
    })
}

/// 根据 ID 查询单条历史记录详情（含 result 和 graph_data）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
#[tauri::command]
pub async fn db_get_history_by_id(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_history_by_id(conn, id)
    })
}

/// 删除指定历史记录。
///
/// # Arguments
///
/// * `id` - 要删除的记录 ID
#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(
        db,
        |conn: &rusqlite::Connection| repository::delete_history(conn, id)
    )
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
        repository::update_history_graph_data(conn, id, &graph_data)
    })
}

/// Query recent correction records for the frontend's buildPersonalizedContext.
#[tauri::command]
pub async fn db_get_recent_correct_results(
    db: State<'_, Db>,
    max_records: i64,
) -> Result<Vec<String>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_recent_correct_results(conn, max_records)
    })
}
