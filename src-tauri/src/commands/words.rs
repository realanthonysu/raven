//! 生词本 CRUD 与复习调度 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_word` - 新增单词
//! - `db_add_words_batch` - 批量新增单词（单事务）
//! - `db_word_exists` - 单词是否已在生词本（加词存在性预检）
//! - `db_get_words` - 查询单词列表（支持可选分页）
//! - `db_get_words_page` - 分页查询单词列表（带同条件 total）
//! - `db_get_word_stats` - 生词等级 × 复习状态聚合统计
//! - `db_delete_word` - 删除单词
//! - `db_update_word_level` - 更新难度等级
//! - `db_update_word_enrichment` - 更新补充信息（音标、释义、笔记）
//! - `db_get_review_stats` - 获取复习统计概览
//! - `db_get_review_words` - 获取待复习单词列表

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::words;

use super::shared::{
    BatchWordResultDto, NewWordInput, ReviewStatsDto, WordDto, WordLevelStatDto, WordPageDto,
    with_db, with_db_read,
};

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
    with_db!(db, |conn: &rusqlite::Connection| words::add_word(
        conn, &input
    ))
}

/// 查询生词列表（按创建时间倒序），支持可选分页与模糊搜索。
///
/// # Arguments
///
/// * `limit` - 可选的最大返回条数（钳制到 1..=500），省略时返回全部
/// * `offset` - 可选偏移量，仅在 `limit` 存在时生效
/// * `search` - 可选搜索关键字：对 word/definition/phonetic 做不区分大小写的包含匹配
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
    with_db_read!(db, |conn: &rusqlite::Connection| words::get_words(
        conn,
        limit,
        offset,
        search.as_deref()
    ))
}

/// 判断单词是否已存在于生词本（大小写不敏感精确匹配）。
///
/// D-05：加词路径的存在性预检只需一个布尔值。此前前端调用 `db_get_words`
/// 拉最多 500 条完整 `WordDto` 再逐条比较，现改为 `lower(word)` 唯一索引上的
/// 等值查询，返回值不携带任何词条内容。
///
/// # Arguments
///
/// * `word` - 要检查的单词（前后空白会被裁掉；空词返回 `false`）
#[tauri::command]
pub async fn db_word_exists(db: State<'_, Db>, word: String) -> Result<bool, AppError> {
    let word = word.trim().to_string();
    with_db_read!(db, |conn: &rusqlite::Connection| words::word_exists(
        conn, &word
    ))
}

/// 分页查询生词列表（按创建时间倒序），并返回同筛选条件下的 total。
///
/// # Arguments
///
/// * `limit` - 每页条数（缺省 100，Rust 侧钳制到 1..=500）
/// * `offset` - 偏移量（缺省 0）
/// * `search` - 可选搜索关键字：对 word/definition/phonetic 做不区分大小写的包含匹配
/// * `level` - 可选等级精确筛选（None 表示不筛选）
#[tauri::command]
pub async fn db_get_words_page(
    db: State<'_, Db>,
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<String>,
    level: Option<String>,
) -> Result<WordPageDto, AppError> {
    let search = search
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let level = level
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    with_db_read!(db, |conn: &rusqlite::Connection| words::get_words_page(
        conn,
        limit,
        offset,
        search.as_deref(),
        level.as_deref()
    ))
}

/// 生词等级 × 复习状态聚合统计（供词汇页分级掌握度卡片使用，避免全量拉词）。
#[tauri::command]
pub async fn db_get_word_stats(db: State<'_, Db>) -> Result<Vec<WordLevelStatDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| words::get_word_stats(
        conn
    ))
}

/// 批量新增单词（整批单事务）。
///
/// 逐条返回 `BatchWordResultDto`：单条校验/写入失败只标记该条 `error`，
/// 不中断其余条目；已存在返回已有 id + `inserted=false`。
#[tauri::command]
pub async fn db_add_words_batch(
    db: State<'_, Db>,
    inputs: Vec<NewWordInput>,
) -> Result<Vec<BatchWordResultDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| words::add_words_batch(
        conn, &inputs
    ))
}

/// 删除指定单词。
///
/// # Arguments
///
/// * `id` - 要删除的单词 ID
#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| words::delete_word(
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
    with_db!(db, |conn: &rusqlite::Connection| words::update_word_level(
        conn, id, &level
    ))
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
/// * `level` - 可选的等级标签（LLM 自动标注）；None 时保留现有等级
#[tauri::command]
pub async fn db_update_word_enrichment(
    db: State<'_, Db>,
    id: i64,
    phonetic: String,
    definition: String,
    notes: String,
    level: Option<String>,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        words::update_word_enrichment(conn, id, &phonetic, &definition, &notes, level.as_deref())
    })
}

/// 获取复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
#[tauri::command]
pub async fn db_get_review_stats(db: State<'_, Db>) -> Result<ReviewStatsDto, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| words::get_review_stats(
        conn
    ))
}

/// 获取待复习单词列表（未掌握且已到期的单词优先）。
///
/// # Arguments
///
/// * `limit` - 最大返回条数
#[tauri::command]
pub async fn db_get_review_words(db: State<'_, Db>, limit: i64) -> Result<Vec<WordDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| words::get_review_words(
        conn, limit
    ))
}
