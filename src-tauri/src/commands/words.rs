//! 生词本 CRUD 与复习调度 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_word` - 新增单词
//! - `db_get_words` - 查询单词列表（支持可选分页）
//! - `db_delete_word` - 删除单词
//! - `db_update_word_level` - 更新难度等级
//! - `db_update_word_enrichment` - 更新补充信息（音标、释义、笔记）
//! - `db_get_review_stats` - 获取复习统计概览
//! - `db_get_review_words` - 获取待复习单词列表

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::traits::{ReadRepository, WriteRepository};

use super::shared::{with_db, with_db_read, NewWordInput, ReviewStatsDto, WordDto};

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
    with_db!(db, |conn: &rusqlite::Connection| conn.add_word(&input))
}

/// 查询生词列表（按创建时间倒序），支持可选分页。
///
/// # Arguments
///
/// * `limit` - 可选的最大返回条数（钳制到 1..=500），省略时返回全部
/// * `offset` - 可选偏移量，仅在 `limit` 存在时生效
#[tauri::command]
pub async fn db_get_words(
    db: State<'_, Db>,
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<String>,
) -> Result<Vec<WordDto>, AppError> {
    // spawn_blocking 闭包是 'static：search 转为自有 String 再 move
    let search = search
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    with_db_read!(db, |conn: &rusqlite::Connection| conn.get_words(
        limit,
        offset,
        search.as_deref()
    ))
}

/// 删除指定单词。
///
/// # Arguments
///
/// * `id` - 要删除的单词 ID
#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| conn.delete_word(id))
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
    with_db!(db, |conn: &rusqlite::Connection| conn
        .update_word_level(id, &level))
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
        conn.update_word_enrichment(id, &phonetic, &definition, &notes)
    })
}

/// 获取复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
#[tauri::command]
pub async fn db_get_review_stats(db: State<'_, Db>) -> Result<ReviewStatsDto, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn.get_review_stats())
}

/// 获取待复习单词列表（未掌握且已到期的单词优先）。
///
/// # Arguments
///
/// * `limit` - 最大返回条数
#[tauri::command]
pub async fn db_get_review_words(db: State<'_, Db>, limit: i64) -> Result<Vec<WordDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn
        .get_review_words(limit))
}
