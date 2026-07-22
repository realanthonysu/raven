//! 生词本 CRUD + 复习调度。

use rusqlite::params;

use crate::commands::shared::{row_to_word, NewWordInput, ReviewStatsDto, WordDto};
use crate::error::AppError;
use crate::fsrs::FsrsReviewUpdate;

use super::validate_review_status;

/// P3-9: 入参重构为 NewWordInput struct，替代原先 10 个独立参数。
/// M-6: 校验 word 非空且长度合理，防止无效数据入库。
pub fn add_word(conn: &rusqlite::Connection, input: &NewWordInput) -> Result<i64, AppError> {
    if input.word.trim().is_empty() {
        return Err(AppError::Database("word cannot be empty".to_string()));
    }
    if input.word.len() > 200 {
        return Err(AppError::Database(
            "word is too long (max 200 chars)".to_string(),
        ));
    }
    conn.execute(
        "INSERT INTO words (word, phonetic, definition, level, source_type, source_text, notes, review_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            input.word,
            input.phonetic,
            input.definition,
            input.level,
            input.source_type,
            input.source_text,
            input.notes,
            input.review_status.as_deref().unwrap_or("new"),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 查询所有生词列表（按创建时间倒序）。
///
/// # Returns
///
/// 包含完整字段（含 FSRS 状态）的单词 DTO 列表。
pub fn get_words(conn: &rusqlite::Connection) -> Result<Vec<WordDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words ORDER BY created_at DESC",
    )?;
    let words = stmt
        .query_map([], row_to_word)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

/// 删除指定生词。
///
/// # Arguments
///
/// * `id` - 要删除的单词 ID
pub fn delete_word(conn: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
    conn.execute("DELETE FROM words WHERE id = ?1", params![id])?;
    Ok(())
}

/// 更新单词的难度等级。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `level` - 新的难度等级标签
pub fn update_word_level(
    conn: &rusqlite::Connection,
    id: i64,
    level: &str,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE words SET level = ?1 WHERE id = ?2",
        params![level, id],
    )?;
    Ok(())
}

/// 更新单词的补充信息（音标、释义、笔记）。
///
/// 通常在 LLM API 返回单词详情后调用。
pub fn update_word_enrichment(
    conn: &rusqlite::Connection,
    id: i64,
    phonetic: &str,
    definition: &str,
    notes: &str,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE words SET phonetic = ?1, definition = ?2, notes = ?3 WHERE id = ?4",
        params![phonetic, definition, notes, id],
    )?;
    Ok(())
}

/// 查询复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
///
/// `due_count` 的计算条件与 [`get_review_words`] 保持一致：
/// 排除 mastered 且 next_review_at 为 NULL 或已到期。
pub fn get_review_stats(conn: &rusqlite::Connection) -> Result<ReviewStatsDto, AppError> {
    // due_count 条件与 get_review_words 保持一致：排除 mastered 词
    // （review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now'))）
    let row = conn.query_row(
        "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN review_status = 'new' THEN 1 ELSE 0 END), 0) as new_count, COALESCE(SUM(CASE WHEN review_status = 'learning' THEN 1 ELSE 0 END), 0) as learning_count, COALESCE(SUM(CASE WHEN review_status = 'mastered' THEN 1 ELSE 0 END), 0) as mastered_count, COALESCE(SUM(CASE WHEN review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) THEN 1 ELSE 0 END), 0) as due_count FROM words",
        [],
        |row| {
            Ok(ReviewStatsDto {
                total: row.get("total")?,
                new_count: row.get("new_count")?,
                learning_count: row.get("learning_count")?,
                mastered_count: row.get("mastered_count")?,
                due_count: row.get("due_count")?,
            })
        },
    )?;
    Ok(row)
}

/// 查询待复习单词列表（未掌握且已到期的单词优先）。
///
/// 排序规则：新词优先，其次按 next_review_at 升序（最早到期的排最前）。
///
/// # Arguments
///
/// * `limit` - 最大返回条数（自动钳制到 1..=500 范围，防止恶意/异常大值导致 OOM）
pub fn get_review_words(conn: &rusqlite::Connection, limit: i64) -> Result<Vec<WordDto>, AppError> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1",
    )?;
    let words = stmt
        .query_map(params![limit], row_to_word)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

/// 原子操作：计算 FSRS 下次复习参数并立即更新数据库（H-3 修复）。
///
/// 将 `calculate_next_review` 和 `update_word_review_fsrs` 合并为单一函数，
/// 消除两步操作之间的崩溃窗口和部分成功状态不一致问题。
pub fn calculate_and_update_review(
    conn: &rusqlite::Connection,
    id: i64,
    card: &crate::fsrs::FsrsCard,
    rating: crate::fsrs::FsrsRating,
) -> Result<crate::fsrs::ReviewCalcResult, AppError> {
    let input = crate::fsrs::ReviewCalcInput {
        card: card.clone(),
        rating,
    };
    let result = crate::fsrs::calculate_next_review(input);
    let update = crate::fsrs::FsrsReviewUpdate {
        id,
        status: result.status.clone(),
        review_count: result.card.reps,
        next_review_at: Some(result.next_review_at.clone()),
        card: result.card.clone(),
    };
    update_word_review_fsrs(conn, &update)?;
    Ok(result)
}

/// P3-5 / P3-8: 入参重构为 FsrsReviewUpdate struct，替代原先 12 个独立参数。
/// 同时校验 review_status 白名单。
/// P3-7: card.state 为 FsrsState enum，写入 DB 时通过 i64::from 转换为 i64。
pub fn update_word_review_fsrs(
    conn: &rusqlite::Connection,
    input: &FsrsReviewUpdate,
) -> Result<(), AppError> {
    validate_review_status(&input.status)?;
    conn.execute(
        "UPDATE words SET review_status = ?1, review_count = ?2, next_review_at = ?3, stability = ?4, difficulty = ?5, elapsed_days = ?6, scheduled_days = ?7, reps = ?8, lapses = ?9, state = ?10 WHERE id = ?11",
        params![
            input.status,
            input.review_count,
            input.next_review_at,
            input.card.stability,
            input.card.difficulty,
            input.card.elapsed_days,
            input.card.scheduled_days,
            input.card.reps,
            input.card.lapses,
            i64::from(input.card.state),
            input.id,
        ],
    )?;
    Ok(())
}
