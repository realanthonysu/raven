//! 生词本 CRUD + 复习调度。

use rusqlite::{OptionalExtension, params};

use crate::dto::{
    BatchWordResultDto, NewWordInput, ReviewStatsDto, WordDto, WordLevelStatDto, WordPageDto,
    row_to_word,
};
use crate::error::AppError;
use crate::fsrs::FsrsReviewUpdate;

use super::validate_review_status;

/// P3-9: 入参重构为 NewWordInput struct，替代原先 10 个独立参数。
/// M-6: 校验 word 非空且长度合理，防止无效数据入库。
/// F-7: level 入参经 validate_word_level 白名单校验（None / 空串合法，非法值拒绝）。
///
/// 幂等语义（H2）：在同一 `BEGIN IMMEDIATE` 事务内先按单词查询（忽略大小写），
/// 已存在则直接返回已有 id（不重复插入、不报错），不存在才插入。这保证了：
/// - 前端"删除生词后同会话重新添加"不会因内存态残留而失败
/// - 应用重启后重复添加同一单词不会产生重复行
/// - 并发添加同一单词（连接池存在多连接）由事务串行化，消除 check-then-act 竞态
pub fn add_word(conn: &rusqlite::Connection, input: &NewWordInput) -> Result<i64, AppError> {
    let review_status = validate_new_word(input)?;
    super::with_immediate_tx(conn, |conn| {
        let (id, _inserted) = insert_word_if_absent(conn, input, review_status)?;
        Ok(id)
    })
}

/// 校验新增单词入参（不触碰数据库），返回归一化后的 review_status。
///
/// 从 `add_word` 抽出，供单条与批量写路径共用；批量为逐条失败继续的语义，
/// 因此校验失败不会中止整个批次。
fn validate_new_word(input: &NewWordInput) -> Result<&str, AppError> {
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
    // F-7: 校验 level 白名单（与前端 WordLevelSchema 对齐），在进入事务前拒绝非法值
    super::validate_word_level(input.level.as_deref())?;
    Ok(review_status)
}

/// 在调用方已开启的连接/事务内执行幂等插入（不自行开启事务）。
///
/// 返回 `(id, inserted)`：`inserted=true` 表示本次真正插入；`false` 表示
/// 已存在（含大小写变体）并返回已有 id。
///
/// 大小写不敏感匹配：与 `get_words` 的 lower() 搜索语义一致，避免同词不同写法
/// （如句首大写 "Hello" vs "hello"）产生重复行。013 迁移建有 lower(word) 表达式
/// 唯一索引：并发添加时另一连接可能在本事务 SELECT 之后抢先 INSERT
/// （check-then-act 竞态），此时下方 INSERT 抛 UNIQUE 约束错误，捕获后回读已有行 id。
fn insert_word_if_absent(
    conn: &rusqlite::Connection,
    input: &NewWordInput,
    review_status: &str,
) -> Result<(i64, bool), AppError> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM words WHERE lower(word) = lower(?1) LIMIT 1",
            params![input.word],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok((id, false));
    }
    match conn.execute(
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
    ) {
        Ok(_) => Ok((conn.last_insert_rowid(), true)),
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation
                && err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            let id: i64 = conn.query_row(
                "SELECT id FROM words WHERE lower(word) = lower(?1) LIMIT 1",
                params![input.word],
                |row| row.get(0),
            )?;
            Ok((id, false))
        }
        Err(e) => Err(e.into()),
    }
}

/// 批量幂等添加单词：整批共用一个 `BEGIN IMMEDIATE` 事务。
///
/// 语义与 [`add_word`] 一致，但：
/// - 单条校验失败（空词/超长/非法 level/review_status）只在该条结果里写 `error`，
///   继续处理后续条目，不整批失败；
/// - 已存在（含大小写变体）返回 `id = Some(existing_id)` + `inserted = false`；
/// - 重复词在批内第二次出现时，第一次的 INSERT 已在本事务内可见，同样返回
///   `inserted = false`，不会重复插入。
///
/// 注意：本函数内部不得再调用 `with_immediate_tx`/`conn.transaction()`——SQLite
/// 不支持嵌套事务，外层事务由本函数统一开启。
pub fn add_words_batch(
    conn: &rusqlite::Connection,
    inputs: &[NewWordInput],
) -> Result<Vec<BatchWordResultDto>, AppError> {
    super::with_immediate_tx(conn, |conn| {
        let mut results = Vec::with_capacity(inputs.len());
        for input in inputs {
            match validate_new_word(input) {
                Ok(review_status) => match insert_word_if_absent(conn, input, review_status) {
                    Ok((id, inserted)) => results.push(BatchWordResultDto {
                        id: Some(id),
                        inserted,
                        error: None,
                    }),
                    Err(e) => results.push(BatchWordResultDto {
                        id: None,
                        inserted: false,
                        error: Some(e.to_string()),
                    }),
                },
                Err(e) => results.push(BatchWordResultDto {
                    id: None,
                    inserted: false,
                    error: Some(e.to_string()),
                }),
            }
        }
        Ok(results)
    })
}

/// get_words 查询的完整字段列表（含 FSRS 状态），与 row_to_word 映射保持一致。
const WORD_FIELDS: &str = "id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state";

/// 查询生词列表（按创建时间倒序），支持可选分页与模糊搜索。
///
/// # Arguments
///
/// * `limit` - 可选的最大返回条数（钳制到 1..=500，防止异常大值导致 OOM）；
///   `None` 表示返回全部
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

/// 分页查询生词列表（按创建时间倒序），同时返回同筛选条件的总数。
///
/// 与 [`get_words`] 的区别：
/// - `limit` 缺省为 100（并钳制到 1..=500），**不会无上限返回整表**；
/// - 返回 `WordPageDto { items, total }`，`total` 由同 WHERE 条件的
///   `SELECT COUNT(*)` 计算，供前端分页器使用；
/// - 新增可选 `level` 精确筛选（`None`/空串表示不筛选）。
///
/// `search` 匹配 word/definition/phonetic 三列（不区分大小写，`%kw%` 包含匹配）；
/// `level` 筛选与 `search` 为 AND 关系。SQL 使用 `?1 IS NULL OR ...` 形式，
/// 无筛选时保持与 `get_words` 一致的顺序索引扫描路径。
pub fn get_words_page(
    conn: &rusqlite::Connection,
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<&str>,
    level: Option<&str>,
) -> Result<WordPageDto, AppError> {
    let effective_limit = limit.map(|l| l.clamp(1, 500)).unwrap_or(100);
    let effective_offset = offset.unwrap_or(0).max(0);
    let search_pattern = search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", s.to_lowercase()));
    let level = level.map(str::trim).filter(|s| !s.is_empty());

    const WHERE_CLAUSE: &str = "WHERE (?1 IS NULL OR lower(word) LIKE ?1 OR lower(definition) LIKE ?1 OR lower(COALESCE(phonetic, '')) LIKE ?1) AND (?2 IS NULL OR level = ?2)";

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM words {WHERE_CLAUSE}"),
        params![search_pattern.as_deref(), level],
        |row| row.get(0),
    )?;

    let mut stmt = conn.prepare(&format!(
        "SELECT {WORD_FIELDS} FROM words {WHERE_CLAUSE} ORDER BY created_at DESC LIMIT ?3 OFFSET ?4"
    ))?;
    let items = stmt
        .query_map(
            params![
                search_pattern.as_deref(),
                level,
                effective_limit,
                effective_offset
            ],
            row_to_word,
        )?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(WordPageDto { items, total })
}

/// 按等级 × 复习状态聚合生词数量（`GROUP BY level, review_status`）。
///
/// 词汇页的分级掌握度统计只需聚合数字，不应为此拉取全量 `WordDto`。
/// `level` 为 NULL 的组也会返回（`WordLevelStatDto.level = None`）。
pub fn get_word_stats(conn: &rusqlite::Connection) -> Result<Vec<WordLevelStatDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT level, review_status, COUNT(*) AS count FROM words GROUP BY level, review_status ORDER BY level, review_status",
    )?;
    let stats = stmt
        .query_map([], |row| {
            Ok(WordLevelStatDto {
                level: row.get("level")?,
                review_status: row.get("review_status")?,
                count: row.get("count")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(stats)
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
/// * `level` - 新的难度等级标签（空串清空等级；非法值被 validate_word_level 拒绝）
pub fn update_word_level(
    conn: &rusqlite::Connection,
    id: i64,
    level: &str,
) -> Result<(), AppError> {
    // F-7: 校验 level 为合法值或空字符串（清空等级）。
    // 白名单收敛到 repository::validate_word_level（中国英语考试体系全锚点，
    // 与前端 WordLevelSchema 对齐，见 src/lib/schemas.ts）
    super::validate_word_level(Some(level))?;
    conn.execute(
        "UPDATE words SET level = ?1 WHERE id = ?2",
        params![level, id],
    )?;
    Ok(())
}

/// 更新单词的补充信息（音标、释义、笔记）。
///
/// 通常在 LLM API 返回单词详情后调用。
/// `level` 为 Some 时仅在现有等级为空（NULL 或空串）时回填 LLM 自动标注；
/// 已有等级（手动标记 / CSV 导入 / 先前的自动标注）永不被覆盖 ——
/// 旧的 COALESCE 语义在"先自动标注、后自动标注"的场景下会逐次覆写，
/// 与"已有等级优先"的约定不符。
/// F-7: level 为 Some 时经 validate_word_level 白名单校验，LLM 越界值在此拒绝。
pub fn update_word_enrichment(
    conn: &rusqlite::Connection,
    id: i64,
    phonetic: &str,
    definition: &str,
    notes: &str,
    level: Option<&str>,
) -> Result<(), AppError> {
    super::validate_word_level(level)?;
    conn.execute(
        "UPDATE words SET phonetic = ?1, definition = ?2, notes = ?3, level = CASE WHEN level IS NULL OR level = '' THEN ?4 ELSE level END WHERE id = ?5",
        params![phonetic, definition, notes, level, id],
    )?;
    Ok(())
}

/// 查询复习统计概览：总数、新词数、学习中数、已掌握数、待复习数。
///
/// `due_count` 的计算条件与 [`get_review_words`] 保持一致：
/// 排除 mastered 且 next_review_at 为 NULL 或已到期。
pub fn get_review_stats(conn: &rusqlite::Connection) -> Result<ReviewStatsDto, AppError> {
    // due_count 条件与 get_review_words 保持一致：排除 mastered 词。
    // next_review_at 由 fsrs.rs 以 **UTC** 写入（011 迁移统一，无时区标记），
    // 因此比较基准是 datetime('now')（恒为 UTC），与时区/夏令时无关。
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
    let mut stmt = conn.prepare(&format!(
        "SELECT {WORD_FIELDS} FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1"
    ))?;
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
    // next_review_at 由本模块以 UTC 写入（011 迁移起，见 fsrs.rs 注释），与 Utc::now 同基准
    let remaining_days = (next - chrono::Utc::now().naive_utc()).num_days();
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

    // BEGIN IMMEDIATE（见 with_immediate_tx）：并发复习同一词时串行执行，
    // 后到的事务读到先到事务提交后的状态，消除丢失更新
    super::with_immediate_tx(conn, |conn| {
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
    })
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

    #[test]
    fn add_word_accepts_valid_level() {
        let conn = create_test_db();
        let mut input = make_word("negotiate");
        input.level = Some("CET-6".to_string());
        let id = add_word(&conn, &input).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].id, id);
        assert_eq!(words[0].level.as_deref(), Some("CET-6"));
    }

    #[test]
    fn add_word_rejects_invalid_level() {
        let conn = create_test_db();
        // LLM 越界等级（GRE）与 CEFR 码（B2，属 difficulty_level 口径）都应被拒绝
        for bad in ["GRE", "B2", "cet-4"] {
            let mut input = make_word("test");
            input.level = Some(bad.to_string());
            let result = add_word(&conn, &input);
            assert!(result.is_err(), "非法 level '{bad}' 应被白名单拒绝");
        }
    }

    // ── H2 幂等：重复添加返回已有 id 且不插入重复行 ──

    #[test]
    fn add_word_is_idempotent_for_duplicate_word() {
        let conn = create_test_db();
        // 同一单词重复添加：返回已有 id，不插入重复行
        let id1 = add_word(&conn, &make_word("hello")).unwrap();
        let id2 = add_word(&conn, &make_word("hello")).unwrap();
        assert_eq!(id1, id2, "重复添加同一单词应返回已有 id 而非新 id");
        assert_eq!(get_words(&conn, None, None, None).unwrap().len(), 1);

        // 大小写变体视为同一单词（与搜索语义一致），避免同词不同写法产生重复行
        let id3 = add_word(&conn, &make_word("Hello")).unwrap();
        assert_eq!(id3, id1, "大小写变体应命中已有 id");
        assert_eq!(get_words(&conn, None, None, None).unwrap().len(), 1);
    }

    #[test]
    fn add_word_readds_after_delete() {
        // 删除后重新添加应产生新行（复用旧行无意义），但不产生重复行
        let conn = create_test_db();
        let id1 = add_word(&conn, &make_word("hello")).unwrap();
        delete_word(&conn, id1).unwrap();
        let id2 = add_word(&conn, &make_word("hello")).unwrap();
        assert_ne!(id1, id2, "删除后重新添加应产生新行");
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words.len(), 1, "删除后重新添加不应残留重复行");
        assert_eq!(words[0].id, id2);
    }

    // ── add_words_batch ──

    #[test]
    fn add_words_batch_inserts_multiple_and_marks_existing() {
        let conn = create_test_db();
        let inputs = vec![make_word("alpha"), make_word("beta"), make_word("gamma")];

        let results = add_words_batch(&conn, &inputs).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.inserted && r.error.is_none()));
        let ids: Vec<i64> = results.iter().map(|r| r.id.unwrap()).collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(get_words(&conn, None, None, None).unwrap().len(), 3);

        // 整批重复：全部返回已存在 id + inserted=false，不新增行
        let again = add_words_batch(&conn, &inputs).unwrap();
        assert_eq!(again.len(), 3);
        for (result, original) in again.iter().zip(results.iter()) {
            assert!(!result.inserted);
            assert_eq!(result.id, original.id);
            assert!(result.error.is_none());
        }
        assert_eq!(get_words(&conn, None, None, None).unwrap().len(), 3);
    }

    #[test]
    fn add_words_batch_continues_after_invalid_items() {
        let conn = create_test_db();
        let mut empty = make_word("");
        empty.review_status = Some("new".to_string());
        let mut bad_level = make_word("bad_level");
        bad_level.level = Some("GRE".to_string());
        let good = make_word("good_word");

        let results = add_words_batch(&conn, &[empty, bad_level, good]).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results[0].error.is_some());
        assert_eq!(results[0].id, None);
        assert!(results[1].error.is_some());
        assert_eq!(results[1].id, None);
        assert!(results[2].inserted);
        assert!(results[2].error.is_none());
        assert!(results[2].id.is_some());

        // 非法条目未落库，合法条目已提交
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "good_word");
    }

    #[test]
    fn add_words_batch_dedupes_case_variants_within_and_across_batches() {
        let conn = create_test_db();
        let results = add_words_batch(
            &conn,
            &[make_word("Hello"), make_word("hello"), make_word("HELLO")],
        )
        .unwrap();
        assert!(results[0].inserted);
        assert!(!results[1].inserted);
        assert!(!results[2].inserted);
        assert_eq!(results[0].id, results[1].id);
        assert_eq!(results[1].id, results[2].id);
        assert_eq!(get_words(&conn, None, None, None).unwrap().len(), 1);
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

    // ── get_words_page / get_word_stats（D-02） ──

    #[test]
    fn get_words_page_returns_total_and_paginates() {
        let conn = create_test_db();
        for i in 0..5 {
            let id = add_word(&conn, &make_word(&format!("word_{i}"))).unwrap();
            // 固定不同的 created_at，避免同秒插入让 ORDER BY created_at 的
            // 分页边界变得不确定（真实记录通常相隔数秒以上）
            conn.execute(
                "UPDATE words SET created_at = ?1 WHERE id = ?2",
                params![format!("2026-01-0{} 00:00:00", i + 1), id],
            )
            .unwrap();
        }

        let page = get_words_page(&conn, Some(2), Some(2), None, None).unwrap();
        assert_eq!(page.total, 5, "total 应为同筛选条件下的总行数");
        assert_eq!(page.items.len(), 2);

        let first_page = get_words_page(&conn, Some(2), None, None, None).unwrap();
        assert_eq!(first_page.items.len(), 2);
        assert!(
            first_page
                .items
                .iter()
                .all(|w| page.items.iter().all(|p| p.id != w.id)),
            "第二页不应与第一页重叠"
        );

        let empty_page = get_words_page(&conn, Some(2), Some(10), None, None).unwrap();
        assert_eq!(empty_page.total, 5);
        assert!(empty_page.items.is_empty());
    }

    #[test]
    fn get_words_page_filters_by_search_and_level() {
        let conn = create_test_db();
        let mut apple = make_word("apple");
        apple.level = Some("CET-4".to_string());
        let mut apricot = make_word("apricot");
        apricot.level = Some("CET-4".to_string());
        let mut banana = make_word("banana");
        banana.level = Some("CET-6".to_string());
        banana.definition = "一种黄色的水果".to_string();
        for word in [&apple, &apricot, &banana] {
            add_word(&conn, word).unwrap();
        }

        // 搜索 + level 为 AND 关系
        let by_search = get_words_page(&conn, Some(10), None, Some("ap"), Some("CET-4")).unwrap();
        assert_eq!(by_search.total, 2);
        assert_eq!(by_search.items.len(), 2);
        assert!(by_search.items.iter().all(|w| w.word.starts_with("ap")));

        // 仅 level 筛选
        let by_level = get_words_page(&conn, Some(10), None, None, Some("CET-6")).unwrap();
        assert_eq!(by_level.total, 1);
        assert_eq!(by_level.items[0].word, "banana");

        // 仅搜索定义（中文）
        let by_definition = get_words_page(&conn, Some(10), None, Some("黄色"), None).unwrap();
        assert_eq!(by_definition.total, 1);

        // 无匹配
        let none = get_words_page(&conn, Some(10), None, Some("zzz"), None).unwrap();
        assert_eq!(none.total, 0);
        assert!(none.items.is_empty());
    }

    #[test]
    fn get_word_stats_groups_by_level_and_review_status() {
        let conn = create_test_db();
        let mut new_cet4 = make_word("new_cet4");
        new_cet4.level = Some("CET-4".to_string());
        let mut learning_cet4 = make_word("learning_cet4");
        learning_cet4.level = Some("CET-4".to_string());
        learning_cet4.review_status = Some("learning".to_string());
        let mut mastered_cet4 = make_word("mastered_cet4");
        mastered_cet4.level = Some("CET-4".to_string());
        mastered_cet4.review_status = Some("mastered".to_string());
        let unmarked = make_word("unmarked");
        for word in [&new_cet4, &learning_cet4, &mastered_cet4, &unmarked] {
            add_word(&conn, word).unwrap();
        }

        let stats = get_word_stats(&conn).unwrap();
        let find = |level: Option<&str>, status: &str| -> i64 {
            stats
                .iter()
                .find(|s| s.level.as_deref() == level && s.review_status == status)
                .map(|s| s.count)
                .unwrap_or(0)
        };
        assert_eq!(find(Some("CET-4"), "new"), 1);
        assert_eq!(find(Some("CET-4"), "learning"), 1);
        assert_eq!(find(Some("CET-4"), "mastered"), 1);
        assert_eq!(find(None, "new"), 1, "未标记等级的词应归入 level=None 组");
        assert_eq!(stats.iter().map(|s| s.count).sum::<i64>(), 4);
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
        update_word_enrichment(&conn, id, "/test/", "a test word", "example note", None).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].phonetic, Some("/test/".to_string()));
        assert_eq!(words[0].notes, Some("example note".to_string()));
    }

    #[test]
    fn update_word_enrichment_sets_and_preserves_level() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        // Some：现有等级为空时回填 LLM 自动标注
        update_word_enrichment(&conn, id, "/t/", "word", "note", Some("CET-6")).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].level.as_deref(), Some("CET-6"));
        // None：保留现有等级（不覆盖已有标注）
        update_word_enrichment(&conn, id, "/t2/", "word2", "note2", None).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].level.as_deref(), Some("CET-6"));
        assert_eq!(words[0].phonetic, Some("/t2/".to_string()));
    }

    #[test]
    fn update_word_enrichment_never_overwrites_existing_level() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        update_word_level(&conn, id, "CET-4").unwrap();
        // 已有等级（手动标记）+ Some(LLM 等级) → 保持原值，不被自动标注覆写
        update_word_enrichment(&conn, id, "/t/", "word", "note", Some("TEM-8")).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].level.as_deref(), Some("CET-4"));
        // 其他字段照常更新（等级保留不影响富化数据写入）
        assert_eq!(words[0].phonetic, Some("/t/".to_string()));
        assert_eq!(words[0].notes, Some("note".to_string()));
    }

    #[test]
    fn update_word_enrichment_backfills_empty_string_level() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        // 空串等级（update_word_level 允许清空）视为"无等级"：Some 时回填
        update_word_level(&conn, id, "").unwrap();
        update_word_enrichment(&conn, id, "/t/", "word", "note", Some("CET-6")).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].level.as_deref(), Some("CET-6"));
    }

    #[test]
    fn update_word_enrichment_keeps_null_level_when_none() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        update_word_enrichment(&conn, id, "/t/", "word", "note", None).unwrap();
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].level, None);
    }

    #[test]
    fn update_word_enrichment_rejects_invalid_level() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("test")).unwrap();
        // LLM 越界等级（GRE / CEFR 码）应在写库前被白名单拒绝，
        // 且不留下半写的富化数据（等级校验先于 UPDATE 执行）
        let result = update_word_enrichment(&conn, id, "/x/", "def", "note", Some("GRE"));
        assert!(result.is_err(), "非法 level 应被拒绝");
        let result = update_word_enrichment(&conn, id, "/x/", "def", "note", Some("B2"));
        assert!(result.is_err(), "CEFR 码不是词汇等级标签");
        let words = get_words(&conn, None, None, None).unwrap();
        assert_eq!(words[0].phonetic, None, "校验失败不应写入任何字段");
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

    // ── P0 回归：next_review_at 存 UTC，到期比较必须用 datetime('now')（UTC）──

    #[test]
    fn review_due_uses_utc_comparison() {
        let conn = create_test_db();
        let id = add_word(&conn, &make_word("due_word")).unwrap();

        // 写入"UTC 1 小时前"到期。若误用 datetime('now', 'localtime') 比较
        // （非 UTC 时区下会多加一个偏移），该词会被漏判为未到期。
        let past_utc = (chrono::Utc::now() - chrono::Duration::hours(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        conn.execute(
            "UPDATE words SET next_review_at = ?1 WHERE id = ?2",
            params![past_utc, id],
        )
        .unwrap();

        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.due_count, 1, "UTC 时间已到期应计入 due_count");
        let review = get_review_words(&conn, 10).unwrap();
        assert_eq!(review.len(), 1, "UTC 时间已到期应出现在待复习列表");

        // 写入"UTC 1 天后"到期 —— 不应到期
        let future_utc = (chrono::Utc::now() + chrono::Duration::days(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        conn.execute(
            "UPDATE words SET next_review_at = ?1 WHERE id = ?2",
            params![future_utc, id],
        )
        .unwrap();

        let stats = get_review_stats(&conn).unwrap();
        assert_eq!(stats.due_count, 0, "UTC 时间未到期不应计入 due_count");
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
        let now = chrono::Utc::now().naive_utc();

        // 未到期（还剩约 3 天），排程 5 天 → 已过 2 天。
        // 加 60s 余量抵消 now 捕获与函数内部 Utc::now() 之间的耗时及 num_days 截断
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
