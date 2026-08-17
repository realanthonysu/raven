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
        return Err(AppError::Validation("word cannot be empty".to_string()));
    }
    if input.word.len() > 200 {
        return Err(AppError::Validation(
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

/// get_words 查询的完整字段列表（含 FSRS 状态），与 row_to_word 映射保持一致。
const WORD_FIELDS: &str = "id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state";

/// 查询生词列表（按创建时间倒序），支持可选分页。
///
/// # Arguments
///
/// * `limit` - 可选的最大返回条数（钳制到 1..=500，防止异常大值导致 OOM）；
///   `None` 表示返回全部（VocabularyPage 需要全量数据做前端搜索与去重）
/// * `offset` - 可选偏移量（钳制到 >= 0），仅在 `limit` 存在时生效
///
/// # Returns
///
/// 包含完整字段（含 FSRS 状态）的单词 DTO 列表。
/// 查询生词列表（按创建时间倒序），支持可选分页与模糊搜索。
///
/// # Arguments
///
/// * `limit` - 可选的最大返回条数（钳制到 1..=500）；`None` 表示返回全部
/// * `offset` - 可选偏移量（钳制到 >= 0），仅在 `limit` 存在时生效
/// * `search` - 可选的搜索关键字：按 word/definition/phonetic 做不区分大小写的
///   包含匹配（`%kw%`）。B2: 词汇页大词库搜索此前由前端全量拉取后过滤，
///   改为服务端下推，避免全量 IPC 序列化开销
pub fn get_words(
    conn: &rusqlite::Connection,
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<&str>,
) -> Result<Vec<WordDto>, AppError> {
    let search_pattern = search.map(|s| format!("%{}%", s.trim().to_lowercase()));
    let words = match limit {
        Some(l) => {
            let effective_limit = l.clamp(1, 500);
            let effective_offset = offset.unwrap_or(0).max(0);
            let mut stmt = conn.prepare(&format!(
                "SELECT {WORD_FIELDS} FROM words WHERE (?1 IS NULL OR lower(word) LIKE ?1 OR lower(definition) LIKE ?1 OR lower(COALESCE(phonetic, '')) LIKE ?1) ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
            ))?;
            let rows = stmt.query_map(
                params![search_pattern, effective_limit, effective_offset],
                row_to_word,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {WORD_FIELDS} FROM words WHERE (?1 IS NULL OR lower(word) LIKE ?1 OR lower(definition) LIKE ?1 OR lower(COALESCE(phonetic, '')) LIKE ?1) ORDER BY created_at DESC"
            ))?;
            let rows = stmt.query_map(params![search_pattern], row_to_word)?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
    };
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
        return Err(AppError::Validation(format!(
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
    // due_count 条件与 get_review_words 保持一致：排除 mastered 词。
    // next_review_at 由 fsrs.rs 以本地时间写入（无时区标记），因此比较必须用
    // datetime('now', 'localtime') —— datetime('now') 返回 UTC，混用会错位一个时区偏移
    // （P0 回归：UTC+8 下单词曾晚 8 小时才显示到期）。
    let row = conn.query_row(
        "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN review_status = 'new' THEN 1 ELSE 0 END), 0) as new_count, COALESCE(SUM(CASE WHEN review_status = 'learning' THEN 1 ELSE 0 END), 0) as learning_count, COALESCE(SUM(CASE WHEN review_status = 'mastered' THEN 1 ELSE 0 END), 0) as mastered_count, COALESCE(SUM(CASE WHEN review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now', 'localtime')) THEN 1 ELSE 0 END), 0) as due_count FROM words",
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
        "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now', 'localtime')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1",
    )?;
    let words = stmt
        .query_map(params![limit], row_to_word)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

/// 从数据库行读取服务端权威的 FSRS 卡片状态。
///
/// 返回 `(卡片, next_review_at)`；行不存在时报错，FSRS 数值异常（非有限/负数，
/// 可由直接写库或损坏数据引入）时返回 `None` 由调用方回退到客户端卡片。
fn load_fsrs_card(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<(crate::fsrs::FsrsCard, Option<String>)>, AppError> {
    let row = conn.query_row(
        "SELECT stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, next_review_at FROM words WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, Option<f64>>("stability")?,
                row.get::<_, Option<f64>>("difficulty")?,
                row.get::<_, Option<i64>>("elapsed_days")?,
                row.get::<_, Option<i64>>("scheduled_days")?,
                row.get::<_, Option<i64>>("reps")?,
                row.get::<_, Option<i64>>("lapses")?,
                row.get::<_, Option<i64>>("state")?,
                row.get::<_, Option<String>>("next_review_at")?,
            ))
        },
    );
    match row {
        Ok((
            stability,
            difficulty,
            elapsed_days,
            scheduled_days,
            reps,
            lapses,
            state,
            next_review_at,
        )) => {
            let (Some(stability), Some(difficulty), Some(state), Some(reps)) =
                (stability, difficulty, state, reps)
            else {
                // FSRS 核心列缺失：007 之前的旧行（理论上 ALTER TABLE 会回填默认值，
                // 这里防御 NULL），交由调用方回退到客户端卡片
                return Ok(None);
            };
            if !stability.is_finite()
                || !difficulty.is_finite()
                || stability < 0.0
                || difficulty < 0.0
            {
                tracing::warn!(
                    word_id = id,
                    "invalid FSRS values in DB, falling back to client card"
                );
                return Ok(None);
            }
            Ok(Some((
                crate::fsrs::FsrsCard {
                    stability,
                    difficulty,
                    elapsed_days: elapsed_days.unwrap_or(0),
                    scheduled_days: scheduled_days.unwrap_or(0),
                    reps,
                    lapses: lapses.unwrap_or(0),
                    state: crate::fsrs::FsrsState::from(state),
                },
                next_review_at,
            )))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(AppError::Validation(format!("word {id} not found")))
        }
        Err(e) => Err(e.into()),
    }
}

/// 校验卡片数值合法（serde_json 可把 1e999 解析为 inf，直接进入算法会污染状态）。
fn is_sane_card(card: &crate::fsrs::FsrsCard) -> bool {
    card.stability.is_finite()
        && card.difficulty.is_finite()
        && card.stability >= 0.0
        && card.difficulty >= 0.0
}

/// 由 `next_review_at` 与 `scheduled_days` 推算自上次复习起经过的天数（服务端权威）。
///
/// 逾期复习 elapsed > scheduled_days，提前复习则相应缩短；
/// `next_review_at` 缺失或格式非法时返回 `None`（调用方保留数据库存值）。
fn recompute_elapsed_days(scheduled_days: i64, next_review_at: Option<&str>) -> Option<i64> {
    let raw = next_review_at?;
    let next = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S").ok()?;
    // next_review_at 由本模块以本地时间写入（见 fsrs.rs B-12 注释），与 Local::now 同基准
    let remaining_days = (next - chrono::Local::now().naive_local()).num_days();
    Some((scheduled_days - remaining_days).max(0))
}

/// 原子操作：计算 FSRS 下次复习参数并立即更新数据库（H-3 修复）。
///
/// 读-算-写在同一 `BEGIN IMMEDIATE` 事务内完成，且以**数据库中的 FSRS 状态为权威**：
/// 此前实现完全信任前端传来的 card（stability/reps 等在客户端停留期间可能已过期，
/// 两次快速评分或双窗口会用同一份旧卡片互相覆盖、丢失更新）。仅当数据库数值
/// 异常时才回退到客户端卡片（并校验合法性）。
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

    // BEGIN IMMEDIATE 立即取写锁：并发复习同一词时串行执行，
    // 后到的事务读到先到事务提交后的状态，消除丢失更新
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<crate::fsrs::ReviewCalcResult, AppError> {
        let effective_card = match load_fsrs_card(conn, id)? {
            Some((mut db_card, next_review_at)) => {
                db_card.elapsed_days =
                    recompute_elapsed_days(db_card.scheduled_days, next_review_at.as_deref())
                        .unwrap_or(db_card.elapsed_days);
                db_card
            }
            None => {
                if !is_sane_card(card) {
                    return Err(AppError::Database(
                        "invalid FSRS card from client (non-finite or negative values)".into(),
                    ));
                }
                card.clone()
            }
        };

        let input = crate::fsrs::ReviewCalcInput {
            card: effective_card,
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
    })();

    match outcome {
        Ok(result) => {
            match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(result),
                Err(e) => {
                    // COMMIT 失败(磁盘满/SQLITE_BUSY_SNAPSHOT 等):连接仍处于
                    // 事务状态,必须 ROLLBACK 归还干净连接,否则 r2d2 回收后
                    // 下一个借用者会继承脏事务
                    if let Err(rb) = conn.execute_batch("ROLLBACK") {
                        tracing::warn!(error = %rb, "failed to rollback after COMMIT failure");
                    }
                    Err(AppError::from(e))
                }
            }
        }
        Err(e) => {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                tracing::warn!(error = %rb, "failed to rollback review transaction");
            }
            Err(e)
        }
    }
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
        let _id = add_word(&conn, &input).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
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

    // ── get_words 搜索（B2） ──

    #[test]
    fn get_words_filters_by_search_keyword() {
        let conn = create_test_db();
        add_word(&conn, &make_word("apple")).unwrap();
        let mut banana = make_word("banana");
        banana.definition = "一种黄色的水果".into();
        add_word(&conn, &banana).unwrap();
        add_word(&conn, &make_word("grape")).unwrap();

        // 按单词匹配(不区分大小写)
        let words = get_words(&conn, None, None, Some("Apple")).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "apple");

        // 按释义匹配
        let words = get_words(&conn, None, None, Some("水果")).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "banana");

        // 无匹配返回空
        let words = get_words(&conn, None, None, Some("zzz")).unwrap();
        assert!(words.is_empty());

        // None 不过滤
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words.len(), 3);
    }

    #[test]
    fn get_words_search_respects_pagination() {
        let conn = create_test_db();
        for i in 0..5 {
            add_word(&conn, &make_word(&format!("word_{i}"))).unwrap();
        }
        let page = get_words(&conn, Some(2), Some(1), Some("word")).unwrap();
        assert_eq!(page.len(), 2);
        assert!(page.iter().all(|w| w.word.starts_with("word")));
    }

    // ── get_words ──

    #[test]
    fn get_words_returns_empty_for_fresh_db() {
        let conn = create_test_db();
        let words = get_words(&conn, None, None, None).unwrap();
        assert!(words.is_empty());
    }

    #[test]
    fn get_words_returns_all_words() {
        let conn = create_test_db();
        add_word(&conn, &make_word("a")).unwrap();
        add_word(&conn, &make_word("b")).unwrap();
        add_word(&conn, &make_word("c")).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words.len(), 3);
    }

    #[test]
    fn get_words_respects_limit_and_offset() {
        let conn = create_test_db();
        for i in 0..5 {
            add_word(&conn, &make_word(&format!("word_{i}"))).unwrap();
        }
        let page1 = get_words(&conn, Some(2), None, None).unwrap();
        assert_eq!(page1.len(), 2);
        let page2 = get_words(&conn, Some(2), Some(2), None).unwrap();
        assert_eq!(page2.len(), 2);
        // 两页无重叠
        assert!(page1.iter().all(|w| page2.iter().all(|p| p.id != w.id)));
        let page3 = get_words(&conn, Some(2), Some(4), None).unwrap();
        assert_eq!(page3.len(), 1);
    }

    #[test]
    fn get_words_clamps_invalid_limit_and_offset() {
        let conn = create_test_db();
        for i in 0..3 {
            add_word(&conn, &make_word(&format!("word_{i}"))).unwrap();
        }
        // limit 0 钳制到 1，负 offset 钳制到 0
        let words = get_words(&conn, Some(0), Some(-10), None).unwrap();
        assert_eq!(words.len(), 1);
    }

    // ── delete_word ──

    #[test]
    fn delete_word_removes_word() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("hello")).unwrap();
        delete_word(&conn, id).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
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
        let words = get_words(&conn, None, None, None).unwrap();
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

    // ── P0 回归：next_review_at 存本地时间，到期比较必须用 localtime ──

    #[test]
    fn review_due_uses_local_time_comparison() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("due_word")).unwrap();

        // 写入"本地时间 1 小时前"到期。SQLite datetime('now') 返回 UTC，
        // 在非 UTC 时区下若漏掉 'localtime' 修饰符，该词会被误判为未到期。
        let past_local = (chrono::Local::now() - chrono::Duration::hours(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        conn.execute(
            "UPDATE words SET next_review_at = ?1 WHERE id = ?2",
            params![past_local, id],
        )
        .unwrap();

        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.due_count, 1, "本地时间已到期应计入 due_count");
        let review = get_review_words(&conn, 10).unwrap();
        assert_eq!(review.len(), 1, "本地时间已到期应出现在待复习列表");

        // 写入"本地时间 1 天后"到期 —— 不应到期
        let future_local = (chrono::Local::now() + chrono::Duration::days(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        conn.execute(
            "UPDATE words SET next_review_at = ?1 WHERE id = ?2",
            params![future_local, id],
        )
        .unwrap();

        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.due_count, 0, "本地时间未到期不应计入 due_count");
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
        let words = get_words(&conn, None, None, None).unwrap();
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

    // ── P1：服务端权威状态（不信任前端 card）──

    #[test]
    fn calculate_and_update_review_uses_db_state_not_client_card() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("server_auth")).unwrap();

        // 第一次复习：Good（DB 中卡片为 New 全零，走首评路径）
        let new_card = FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        };
        let first = calculate_and_update_review(&conn, id, &new_card, FsrsRating::Good).unwrap();
        assert_eq!(first.card.reps, 1);

        // 第二次复习：前端传来陈旧/伪造的卡片（stability=999、reps=0）应被忽略，
        // 服务端以 DB 状态（reps=1）续算，消除丢失更新
        let stale = FsrsCard {
            stability: 999.0,
            difficulty: 1.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        };
        let second = calculate_and_update_review(&conn, id, &stale, FsrsRating::Good).unwrap();
        assert_eq!(second.card.reps, 2, "reps 应基于 DB 状态续算而非客户端值");
        assert!(
            second.card.stability < 100.0,
            "不应采用客户端伪造的 stability=999，实际: {}",
            second.card.stability
        );
    }

    #[test]
    fn calculate_and_update_review_errors_on_missing_word() {
        let conn = create_test_db();
        let card = FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        };
        let result = calculate_and_update_review(&conn, 999, &card, FsrsRating::Good);
        assert!(result.is_err(), "不存在的单词应报错而非静默成功");
    }

    #[test]
    fn calculate_and_update_review_rejects_insane_client_card() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("insane")).unwrap();
        // DB 数值异常（inf）→ 回退客户端卡片；客户端卡片同样非法 → 报错
        conn.execute(
            "UPDATE words SET stability = 9e999 WHERE id = ?1",
            params![id],
        )
        .unwrap();
        let result = calculate_and_update_review(&conn, id, &new_insane_card(), FsrsRating::Good);
        assert!(result.is_err());
    }

    /// 构造数值非法的客户端卡片（inf stability）
    fn new_insane_card() -> FsrsCard {
        FsrsCard {
            stability: f64::INFINITY,
            difficulty: 5.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        }
    }

    // ── recompute_elapsed_days：由排程与到期时间推算经过天数 ──

    #[test]
    fn recompute_elapsed_days_math() {
        let fmt = "%Y-%m-%d %H:%M:%S";
        let now = chrono::Local::now().naive_local();

        // 未到期（还剩约 3 天），排程 5 天 → 已过 2 天。
        // 加 60s 余量抵消 now 捕获与函数内部 Local::now() 之间的耗时及 num_days 截断
        let future = (now + chrono::Duration::days(3) + chrono::Duration::seconds(60))
            .format(fmt)
            .to_string();
        assert_eq!(recompute_elapsed_days(5, Some(&future)), Some(2));

        // 已逾期约 2 天，排程 5 天 → 已过 7 天
        let past = (now - chrono::Duration::days(2) - chrono::Duration::seconds(60))
            .format(fmt)
            .to_string();
        assert_eq!(recompute_elapsed_days(5, Some(&past)), Some(7));

        // 缺失 / 非法格式 → None（保留 DB 存值）
        assert_eq!(recompute_elapsed_days(5, None), None);
        assert_eq!(recompute_elapsed_days(5, Some("garbage")), None);

        // 提前很多（还剩约 30 天）不会出现负数
        let far = (now + chrono::Duration::days(30) + chrono::Duration::seconds(60))
            .format(fmt)
            .to_string();
        assert_eq!(recompute_elapsed_days(5, Some(&far)), Some(0));
    }
}
