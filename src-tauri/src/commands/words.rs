/// Word CRUD and review commands.
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, NewWordInput, ReviewStatsDto, WordDto};

/// P3-9: 入参重构为 NewWordInput struct，替代原先 10 个独立参数。
#[tauri::command]
pub async fn db_add_word(db: State<'_, Db>, input: NewWordInput) -> Result<i64, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::add_word(
        conn, &input
    ))
}

#[tauri::command]
pub async fn db_get_words(db: State<'_, Db>) -> Result<Vec<WordDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_words(
        conn
    ))
}

#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::delete_word(
        conn, id
    ))
}

#[tauri::command]
pub async fn db_update_word_level(
    db: State<'_, Db>,
    id: i64,
    level: String,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::update_word_level(conn, id, &level)
    })
}

#[tauri::command]
pub async fn db_update_word_enrichment(
    db: State<'_, Db>,
    id: i64,
    phonetic: String,
    definition: String,
    notes: String,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::update_word_enrichment(conn, id, &phonetic, &definition, &notes)
    })
}

#[tauri::command]
pub async fn db_get_review_stats(db: State<'_, Db>) -> Result<ReviewStatsDto, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_review_stats(conn)
    })
}

#[tauri::command]
pub async fn db_get_review_words(db: State<'_, Db>, limit: i64) -> Result<Vec<WordDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_review_words(conn, limit)
    })
}

#[tauri::command]
pub async fn db_update_word_review(
    db: State<'_, Db>,
    id: i64,
    status: String,
    review_count: i64,
    next_review_at: Option<String>,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::update_word_review(conn, id, &status, review_count, next_review_at.as_deref())
    })
}
