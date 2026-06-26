//! 生词本 CRUD 与复习调度 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_word` - 新增单词
//! - `db_get_words` - 查询所有单词
//! - `db_delete_word` - 删除单词
//! - `db_update_word_level` - 更新难度等级
//! - `db_update_word_enrichment` - 更新补充信息（音标、释义、笔记）
//! - `db_get_review_stats` - 获取复习统计概览
//! - `db_get_review_words` - 获取待复习单词列表
//! - `db_update_word_review` - 更新复习状态（非 FSRS 模式）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, NewWordInput, ReviewStatsDto, WordDto};

/// 新增一个单词到生词本。
///
/// # Arguments
///
/// * `input` - 单词输入参数（含单词、音标、释义、等级等）
///
/// # Returns
///
/// 新插入单词的 ID。
#[tauri::command]
pub async fn db_add_word(db: State<'_, Db>, input: NewWordInput) -> Result<i64, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::add_word(
        conn, &input
    ))
}

/// 查询所有生词列表（按创建时间倒序）。
#[tauri::command]
pub async fn db_get_words(db: State<'_, Db>) -> Result<Vec<WordDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_words(
        conn
    ))
}

/// 删除指定单词。
///
/// # Arguments
///
/// * `id` - 要删除的单词 ID
#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::delete_word(
        conn, id
    ))
}

/// 更新单词的难度等级。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `level` - 新的难度等级标签
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

/// 更新单词的补充信息（音标、释义、笔记）。
///
/// 通常在 LLM API 返回单词详情后调用。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `phonetic` - 音标
/// * `definition` - 释义
/// * `notes` - 用户笔记
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

/// 获取复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
#[tauri::command]
pub async fn db_get_review_stats(db: State<'_, Db>) -> Result<ReviewStatsDto, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_review_stats(conn)
    })
}

/// 获取待复习单词列表（未掌握且已到期的单词优先）。
///
/// # Arguments
///
/// * `limit` - 最大返回条数
#[tauri::command]
pub async fn db_get_review_words(db: State<'_, Db>, limit: i64) -> Result<Vec<WordDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_review_words(conn, limit)
    })
}

/// 更新单词的复习状态（非 FSRS 模式，简化版）。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `status` - 新的复习状态（`"new"` / `"learning"` / `"mastered"`）
/// * `review_count` - 更新后的复习次数
/// * `next_review_at` - 下次复习时间（RFC 3339 格式，可选）
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
