/// History CRUD commands.
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, HistoryDto};

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

#[tauri::command]
pub async fn db_get_history_by_id(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_history_by_id(conn, id)
    })
}

#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(
        db,
        |conn: &rusqlite::Connection| repository::delete_history(conn, id)
    )
}

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
