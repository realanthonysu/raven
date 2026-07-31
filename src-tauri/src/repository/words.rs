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
    let review_status = input.review_status.as_deref().unwrap_or("new");
    // H-3: 校验 review_status 白名单，防止非法值入库
    validate_review_status(review_status)?;
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
            review_status,
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
    // L-3: 校验 level 为合法值或空字符串（清空等级）
    const ALLOWED_LEVELS: &[&str] = &["CET-4", "CET-6", "TEM-4", "TEM-8"];
    if !level.is_empty() && !ALLOWED_LEVELS.contains(&level) {
        return Err(AppError::Database(format!(
            "invalid word level: '{level}', expected one of: {ALLOWED_LEVELS:?}"
        )));
    }
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
///
/// 目标留存率从 settings 表的 `fsrs_request_retention` 键读取（用户可配置），
/// 读取失败或未设置时回退默认值 0.9。
pub fn calculate_and_update_review(
    conn: &rusqlite::Connection,
    id: i64,
    card: &crate::fsrs::FsrsCard,
    rating: crate::fsrs::FsrsRating,
) -> Result<crate::fsrs::ReviewCalcResult, AppError> {
    let retention_raw = crate::repository::settings::get_setting(conn, "fsrs_request_retention")
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "failed to read fsrs_request_retention, using default");
            None
        });
    let retention = crate::fsrs::resolve_retention(retention_raw.as_deref());
    let input = crate::fsrs::ReviewCalcInput {
        card: card.clone(),
        rating,
    };
    let result = crate::fsrs::calculate_next_review_with_retention(input, retention);
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

// ============================================================================
// Integration tests — 使用 create_test_db() 测试完整 CRUD 和 FSRS 逻辑
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;
    use crate::fsrs::{FsrsCard, FsrsRating, FsrsState};

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

    // ── add_word ──

    #[test]
    fn add_word_returns_incrementing_id() {
        let conn = create_test_db();
        let id1 = add_word(&conn, &make_word("hello")).unwrap();
        let id2 = add_word(&conn, &make_word("world")).unwrap();
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn add_word_rejects_empty_word() {
        let conn = create_test_db();
        let result = add_word(&conn, &make_word(""));
        assert!(result.is_err());
    }

    #[test]
    fn add_word_rejects_whitespace_only() {
        let conn = create_test_db();
        let result = add_word(&conn, &make_word("   "));
        assert!(result.is_err());
    }

    #[test]
    fn add_word_rejects_too_long() {
        let conn = create_test_db();
        let long_word = "a".repeat(201);
        let result = add_word(&conn, &make_word(&long_word));
        assert!(result.is_err());
    }

    #[test]
    fn add_word_accepts_200_chars() {
        let conn = create_test_db();
        let word = "a".repeat(200);
        let id = add_word(&conn, &make_word(&word)).unwrap();
        assert_eq!(id, 1);
    }

    #[test]
    fn add_word_with_custom_review_status() {
        let conn = create_test_db();
        let mut input = make_word("test");
        input.review_status = Some("learning".to_string());
        let id = add_word(&conn, &input).unwrap();
        let words = get_words(&conn).unwrap();
        assert_eq!(words[0].review_status, "learning");
    }

    #[test]
    fn add_word_rejects_invalid_review_status() {
        let conn = create_test_db();
        let mut input = make_word("test");
        input.review_status = Some("invalid".to_string());
        let result = add_word(&conn, &input);
        assert!(result.is_err());
    }

    // ── get_words ──

    #[test]
    fn get_words_returns_empty_for_fresh_db() {
        let conn = create_test_db();
        let words = get_words(&conn).unwrap();
        assert!(words.is_empty());
    }

    #[test]
    fn get_words_returns_all_words() {
        let conn = create_test_db();
        add_word(&conn, &make_word("a")).unwrap();
        add_word(&conn, &make_word("b")).unwrap();
        add_word(&conn, &make_word("c")).unwrap();
        let words = get_words(&conn).unwrap();
        assert_eq!(words.len(), 3);
    }

    // ── delete_word ──

    #[test]
    fn delete_word_removes_word() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("hello")).unwrap();
        delete_word(&conn, id).unwrap();
        let words = get_words(&conn).unwrap();
        assert!(words.is_empty());
    }

    // ── update_word_level ──

    #[test]
    fn update_word_level_accepts_valid_levels() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        for level in &["CET-4", "CET-6", "TEM-4", "TEM-8", ""] {
            update_word_level(&conn, id, level).unwrap();
        }
    }

    #[test]
    fn update_word_level_rejects_invalid() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        let result = update_word_level(&conn, id, "GRE");
        assert!(result.is_err());
    }

    // ── update_word_enrichment ──

    #[test]
    fn update_word_enrichment_updates_fields() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        update_word_enrichment(&conn, id, "/test/", "a test word", "example note").unwrap();
        let words = get_words(&conn).unwrap();
        assert_eq!(words[0].phonetic, Some("/test/".to_string()));
        assert_eq!(words[0].notes, Some("example note".to_string()));
    }

    // ── get_review_stats ──

    #[test]
    fn get_review_stats_empty_db() {
        let conn = create_test_db();
        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.total, 0);
        assert_eq!(stats.new_count, 0);
        assert_eq!(stats.due_count, 0);
    }

    #[test]
    fn get_review_stats_counts_by_status() {
        let conn = create_test_db();
        // Add 3 words with different statuses
        let mut w1 = make_word("a");
        w1.review_status = Some("new".to_string());
        add_word(&conn, &w1).unwrap();

        let mut w2 = make_word("b");
        w2.review_status = Some("learning".to_string());
        add_word(&conn, &w2).unwrap();

        let mut w3 = make_word("c");
        w3.review_status = Some("mastered".to_string());
        add_word(&conn, &w3).unwrap();

        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.total, 3);
        assert_eq!(stats.new_count, 1);
        assert_eq!(stats.learning_count, 1);
        assert_eq!(stats.mastered_count, 1);
    }

    // ── get_review_words ──

    #[test]
    fn get_review_words_excludes_mastered() {
        let conn = create_test_db();
        let mut w1 = make_word("new_word");
        w1.review_status = Some("new".to_string());
        add_word(&conn, &w1).unwrap();

        let mut w2 = make_word("mastered_word");
        w2.review_status = Some("mastered".to_string());
        add_word(&conn, &w2).unwrap();

        let review = get_review_words(&conn, 10).unwrap();
        assert_eq!(review.len(), 1);
        assert_eq!(review[0].word, "new_word");
    }

    #[test]
    fn get_review_words_respects_limit() {
        let conn = create_test_db();
        for i in 0..5 {
            add_word(&conn, &make_word(&format!("word_{i}"))).unwrap();
        }
        let review = get_review_words(&conn, 3).unwrap();
        assert_eq!(review.len(), 3);
    }

    // ── calculate_and_update_review ──

    #[test]
    fn calculate_and_update_review_updates_fsrs_fields() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();

        let card = FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        };

        let result = calculate_and_update_review(&conn, id, &card, FsrsRating::Good).unwrap();
        assert_eq!(result.status, "learning");
        assert_eq!(result.card.reps, 1);
        assert!(result.interval >= 1);

        // Verify the DB was updated
        let words = get_words(&conn).unwrap();
        assert_eq!(words[0].review_count, Some(1));
        assert!(words[0].next_review_at.is_some());
    }

    #[test]
    fn calculate_and_update_review_easy_yields_mastered() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();

        let card = FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        };

        let result = calculate_and_update_review(&conn, id, &card, FsrsRating::Easy).unwrap();
        assert_eq!(result.status, "mastered");
    }

    #[test]
    fn calculate_and_update_review_respects_retention_setting() {
        let conn = create_test_db();

        // 先用 Easy 首评得到一张 Review 态卡片（stability 较大，间隔差异可观察）
        let base_card = FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        }
        .review(FsrsRating::Easy);

        // 高留存率（强化模式）：间隔应较短
        let id1 = add_word(&conn, &make_word("w_intensive")).unwrap();
        crate::repository::settings::set_setting(&conn, "fsrs_request_retention", "0.97").unwrap();
        let intensive =
            calculate_and_update_review(&conn, id1, &base_card, FsrsRating::Good).unwrap();

        // 低留存率（轻松模式）：间隔应较长
        let id2 = add_word(&conn, &make_word("w_relaxed")).unwrap();
        crate::repository::settings::set_setting(&conn, "fsrs_request_retention", "0.7").unwrap();
        let relaxed =
            calculate_and_update_review(&conn, id2, &base_card, FsrsRating::Good).unwrap();

        assert!(
            relaxed.interval >= intensive.interval,
            "低留存率间隔应不短于高留存率：{} vs {}",
            relaxed.interval,
            intensive.interval
        );
    }
}
