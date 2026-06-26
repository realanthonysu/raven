//! 数据访问层（Repository）—— 将 SQL 查询与 Tauri Command handler 分离。
//!
//! 每个函数接收 `&rusqlite::Connection` 并返回 `Result<T, AppError>`。
//! Command handler 通过 `with_db!` 宏获取连接后委托给本模块的函数。
//!
//! ## 模块结构
//!
//! - **Models**: 模型配置 CRUD（API Key 存储在 OS Keychain）
//! - **Words**: 生词本 CRUD + 复习调度
//! - **History**: 学习历史记录
//! - **Settings**: 键值对设置（含 TTS 配置）
//! - **Learning**: 学习打卡与目标管理
//! - **Export & Backup**: CSV/Anki 导出与数据库备份

use rusqlite::params;
use std::collections::HashMap;

use crate::commands::shared::*;
use crate::credentials;
use crate::error::AppError;
use crate::fsrs::FsrsReviewUpdate;

// ============================================================================
// String enum validation (防止前端传入非法枚举值破坏查询语义)
// ============================================================================

/// 校验 review_status 参数。合法值: new / learning / mastered。
fn validate_review_status(status: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &["new", "learning", "mastered"];
    if VALID.contains(&status) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Invalid review_status: '{status}'. Expected one of: new, learning, mastered"
        )))
    }
}

/// 校验 record_type 参数。合法值: correct / writing / reading / listening / speaking / exercise。
fn validate_record_type(record_type: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &[
        "correct",
        "writing",
        "reading",
        "listening",
        "speaking",
        "exercise",
    ];
    if VALID.contains(&record_type) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Invalid record_type: '{record_type}'. Expected one of: correct, writing, reading, listening, speaking, exercise"
        )))
    }
}

/// 校验 goal_type 参数。合法值: review / exercise / reading / writing / listening。
fn validate_goal_type(goal_type: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &["review", "exercise", "reading", "writing", "listening"];
    if VALID.contains(&goal_type) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Invalid goal_type: '{goal_type}'. Expected one of: review, exercise, reading, writing, listening"
        )))
    }
}

// ============================================================================
// Models
// ============================================================================

/// 查询所有模型配置列表（按默认模型优先排序）。
///
/// 列表接口不返回 `api_key` 字段，避免密钥泄露到前端列表视图。
///
/// # Returns
///
/// 模型 DTO 列表，`api_key` 字段为空字符串。
pub fn get_models(conn: &rusqlite::Connection) -> Result<Vec<ModelDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, base_url, model_name, is_default FROM models ORDER BY is_default DESC",
    )?;
    let rows: Vec<(i64, String, String, String, bool)> = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // P2-3: 列表接口不返回 api_key，避免密钥泄露到前端列表视图
    let models: Vec<ModelDto> = rows
        .into_iter()
        .map(|(id, name, base_url, model_name, is_default)| ModelDto {
            id,
            name,
            api_key: String::new(),
            base_url,
            model_name,
            is_default,
        })
        .collect();
    Ok(models)
}

/// 新增模型配置。
///
/// 在数据库中插入模型记录，如果设为默认则清除其他默认标记。
/// API Key 在 DB 事务提交后写入 OS Keychain；若 Keychain 写入失败，
/// 则删除刚插入的行作为补偿，避免留下无 Key 的孤儿记录。
///
/// # Arguments
///
/// * `conn` - 可变数据库连接（需要开启事务）
/// * `model` - 新模型的输入参数
///
/// # Returns
///
/// 新插入模型的 ID。
pub fn add_model(conn: &mut rusqlite::Connection, model: &NewModelInput) -> Result<i64, AppError> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO models (name, base_url, model_name, is_default) VALUES (?1, ?2, ?3, 0)",
        params![model.name, model.base_url, model.model_name],
    )?;

    let new_id = tx.last_insert_rowid();

    if model.is_default {
        tx.execute(
            "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![new_id],
        )?;
    }

    // 先提交 DB 事务，再写 Keychain（Keychain 不支持事务回滚）
    tx.commit()?;

    // 提交成功后写 Keychain；若失败则删除刚插入的行作为补偿
    if !model.api_key.is_empty() {
        if let Err(e) = credentials::store_key(new_id, &model.api_key) {
            tracing::error!(error = %e, model_id = new_id, "store_key failed after add_model commit");
            // 补偿：删除刚插入的行，避免留下无 Key 的孤儿记录
            let _ = conn.execute("DELETE FROM models WHERE id = ?1", params![new_id]);
            return Err(e);
        }
    }

    Ok(new_id)
}

/// 删除指定模型配置。
///
/// 从数据库中删除模型记录，同时尝试清理 OS Keychain 中的 API Key。
/// Keychain 删除失败仅记录日志，不影响 DB 已删除的状态。
///
/// # Arguments
///
/// * `id` - 要删除的模型 ID
pub fn delete_model(conn: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
    conn.execute("DELETE FROM models WHERE id = ?1", params![id])?;
    // Keychain 删除失败仅记录日志，不影响 DB 已删除的状态
    if let Err(e) = credentials::delete_key(id) {
        tracing::warn!(error = %e, model_id = id, "failed to delete keychain entry during delete_model");
    }
    Ok(())
}

/// 获取指定模型的 API Key（从 OS Keychain 读取）。
/// P2-3: 列表接口不再返回 api_key，编辑模型时通过此函数单独获取。
pub fn get_model_api_key(model_id: i64) -> Result<String, AppError> {
    Ok(credentials::get_key(model_id)?.unwrap_or_default())
}

/// Primary query for the default model (`is_default = 1`).
/// Returns `None` when no model is flagged as default; the caller is expected
/// to fall back to [`get_first_model`].
pub fn get_default_model(conn: &rusqlite::Connection) -> Result<Option<ModelDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, base_url, model_name, is_default FROM models WHERE is_default = 1 LIMIT 1",
    )?;

    let result = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .next()
        .transpose()?;

    Ok(result.map(|(id, name, base_url, model_name, is_default)| {
        // Keychain 读取失败时记录日志并降级为空 Key，避免阻塞用户使用
        let api_key = match credentials::get_key(id) {
            Ok(Some(k)) => k,
            Ok(None) => String::new(),
            Err(e) => {
                tracing::warn!(error = %e, model_id = id, "keychain read failed in get_default_model");
                String::new()
            }
        };
        ModelDto {
            id,
            name,
            api_key,
            base_url,
            model_name,
            is_default,
        }
    }))
}

/// Fallback query: return the model with the lowest id.
pub fn get_first_model(conn: &rusqlite::Connection) -> Result<Option<ModelDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, base_url, model_name, is_default FROM models ORDER BY id ASC LIMIT 1",
    )?;
    let result = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .next()
        .transpose()?;

    Ok(result.map(|(id, name, base_url, model_name, is_default)| {
        // Keychain 读取失败时记录日志并降级为空 Key，避免阻塞用户使用
        let api_key = match credentials::get_key(id) {
            Ok(Some(k)) => k,
            Ok(None) => String::new(),
            Err(e) => {
                tracing::warn!(error = %e, model_id = id, "keychain read failed in get_first_model");
                String::new()
            }
        };
        ModelDto {
            id,
            name,
            api_key,
            base_url,
            model_name,
            is_default,
        }
    }))
}

/// 设置指定模型为默认模型（清除其他模型的默认标记）。
///
/// # Arguments
///
/// * `id` - 要设为默认的模型 ID
pub fn set_default_model(conn: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
    conn.execute(
        "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
        params![id],
    )?;
    Ok(())
}

/// 更新模型配置（名称、Base URL、模型名、API Key、默认状态）。
///
/// DB 事务先更新基本信息和默认标记，提交后再写 Keychain。
/// 若 Keychain 写入失败仅记录日志（DB 已更新，用户可重新编辑 Key）。
pub fn update_model(
    conn: &mut rusqlite::Connection,
    id: i64,
    name: &str,
    base_url: &str,
    model_name: &str,
    api_key: &str,
    is_default: bool,
) -> Result<(), AppError> {
    let tx = conn.transaction()?;

    tx.execute(
        "UPDATE models SET name = ?1, base_url = ?2, model_name = ?3 WHERE id = ?4",
        params![name, base_url, model_name, id],
    )?;

    // 若设为默认，清除其他模型的默认标记
    if is_default {
        tx.execute(
            "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![id],
        )?;
    }

    // 先提交 DB 事务，再写 Keychain
    tx.commit()?;

    // 提交成功后写 Keychain；若失败仅记录日志（DB 已更新，用户可重新编辑 Key）
    if !api_key.is_empty() {
        if let Err(e) = credentials::store_key(id, api_key) {
            tracing::warn!(error = %e, model_id = id, "store_key failed after update_model commit");
        }
    }

    Ok(())
}

// ============================================================================
// Words
// ============================================================================

/// P3-9: 入参重构为 NewWordInput struct，替代原先 10 个独立参数。
pub fn add_word(conn: &rusqlite::Connection, input: &NewWordInput) -> Result<i64, AppError> {
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
        "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN review_status = 'new' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status = 'learning' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status = 'mastered' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) THEN 1 ELSE 0 END), 0) FROM words",
        [],
        |row| {
            Ok(ReviewStatsDto {
                total: row.get(0)?,
                new_count: row.get(1)?,
                learning_count: row.get(2)?,
                mastered_count: row.get(3)?,
                due_count: row.get(4)?,
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
/// * `limit` - 最大返回条数
pub fn get_review_words(conn: &rusqlite::Connection, limit: i64) -> Result<Vec<WordDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1",
    )?;
    let words = stmt
        .query_map(params![limit], row_to_word)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

/// 更新单词的复习状态（非 FSRS 模式）。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `status` - 新的复习状态（`"new"` / `"learning"` / `"mastered"`）
/// * `review_count` - 更新后的复习次数
/// * `next_review_at` - 下次复习时间（RFC 3339 格式，可选）
pub fn update_word_review(
    conn: &rusqlite::Connection,
    id: i64,
    status: &str,
    review_count: i64,
    next_review_at: Option<&str>,
) -> Result<(), AppError> {
    validate_review_status(status)?;
    conn.execute(
        "UPDATE words SET review_status = ?1, review_count = ?2, next_review_at = ?3 WHERE id = ?4",
        params![status, review_count, next_review_at, id],
    )?;
    Ok(())
}

/// P3-5 / P3-8: 入参重构为 FsrsReviewUpdate struct，替代原先 12 个独立参数。
/// 同时校验 review_status 白名单，与 update_word_review 保持一致。
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
// History
// ============================================================================

/// 新增一条学习历史记录。
///
/// # Arguments
///
/// * `record_type` - 记录类型（`"correct"` / `"writing"` / `"reading"` 等，经白名单校验）
/// * `input_text` - 用户输入的原始文本
/// * `result` - LLM 返回的结果文本
/// * `graph_data` - 可选的图表数据（JSON 字符串）
///
/// # Returns
///
/// 新插入记录的 ID。
pub fn add_history(
    conn: &rusqlite::Connection,
    record_type: &str,
    input_text: &str,
    result: &str,
    graph_data: Option<&str>,
) -> Result<i64, AppError> {
    validate_record_type(record_type)?;
    conn.execute(
        "INSERT INTO history (type, input_text, result, graph_data) VALUES (?1, ?2, ?3, ?4)",
        params![record_type, input_text, result, graph_data],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 查询历史记录列表（含完整字段，按创建时间倒序）。
///
/// 支持按记录类型过滤和分页。如需轻量级列表查询（不含 result 和 graph_data），
/// 请使用 [`get_history_list`]。
pub fn get_history(
    conn: &rusqlite::Connection,
    record_types: Option<&[&str]>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    query_history(
        conn,
        "id, type, input_text, result, graph_data, created_at",
        record_types,
        limit,
        offset,
    )
}

/// Lightweight history list query for the HistoryPage list view.
/// Excludes the heavy `result` and `graph_data` columns that can be very large.
/// The list view only needs id, type, input_text, and created_at.
pub fn get_history_list(
    conn: &rusqlite::Connection,
    record_types: Option<&[&str]>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    query_history(
        conn,
        "id, type, input_text, '', NULL, created_at",
        record_types,
        limit,
        offset,
    )
}

/// 内部辅助函数：按字段列表和过滤条件查询历史记录。
/// 消除 get_history 与 get_history_list 之间的重复 SQL 构建逻辑。
/// 支持按单个 type 或一组 type 过滤。
/// P3-6: 入口处校验每个 record_type 白名单，防止前端传入非法枚举值。
fn query_history(
    conn: &rusqlite::Connection,
    fields: &str,
    record_types: Option<&[&str]>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    if let Some(types) = record_types {
        for t in types {
            validate_record_type(t)?;
        }
    }
    let effective_limit = limit.unwrap_or(-1);
    let effective_offset = offset.unwrap_or(0);

    let records: Vec<HistoryDto> = match record_types {
        Some(types) if types.len() == 1 => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {fields} FROM history WHERE type = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
            ))?;
            let rows = stmt.query_map(
                params![types[0], effective_limit, effective_offset],
                row_to_history,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        Some(types) if !types.is_empty() => {
            let placeholders: Vec<String> = types.iter().map(|_| "?".to_string()).collect();
            let in_clause = placeholders.join(", ");
            let sql = format!(
                "SELECT {fields} FROM history WHERE type IN ({in_clause}) ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
                types.len() + 1,
                types.len() + 2
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = types
                .iter()
                .map(|t| t as &dyn rusqlite::ToSql)
                .chain([
                    &effective_limit as &dyn rusqlite::ToSql,
                    &effective_offset as &dyn rusqlite::ToSql,
                ])
                .collect();
            let rows = stmt.query_map(rusqlite::params_from_iter(params), row_to_history)?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        _ => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {fields} FROM history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            ))?;
            let rows =
                stmt.query_map(params![effective_limit, effective_offset], row_to_history)?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(records)
}

/// 根据 ID 查询单条历史记录（含完整字段）。
///
/// # Returns
///
/// 匹配的记录，未找到时返回 `None`。
pub fn get_history_by_id(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, type, input_text, result, graph_data, created_at FROM history WHERE id = ?1 LIMIT 1",
    )?;
    let record = stmt
        .query_map(params![id], row_to_history)?
        .next()
        .transpose()?;
    Ok(record)
}

/// 删除指定历史记录。
///
/// # Arguments
///
/// * `id` - 要删除的记录 ID
pub fn delete_history(conn: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
    conn.execute("DELETE FROM history WHERE id = ?1", params![id])?;
    Ok(())
}

/// 更新历史记录的图表数据。
///
/// 通常在 LLM 流式返回完成、前端解析出图表数据后异步回写。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
/// * `graph_data` - 图表数据 JSON 字符串
pub fn update_history_graph_data(
    conn: &rusqlite::Connection,
    id: i64,
    graph_data: &str,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE history SET graph_data = ?1 WHERE id = ?2",
        params![graph_data, id],
    )?;
    Ok(())
}

/// Query recent correction records for the frontend's buildPersonalizedContext.
pub fn get_recent_correct_results(
    conn: &rusqlite::Connection,
    max_records: i64,
) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT result FROM history WHERE type IN ('correct', 'writing') ORDER BY created_at DESC LIMIT ?1",
    )?;
    let results = stmt
        .query_map(params![max_records], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(results)
}

// ============================================================================
// Settings
// ============================================================================

/// 查询单个设置项的值。
///
/// # Arguments
///
/// * `key` - 设置键名
///
/// # Returns
///
/// 设置值，不存在时返回 `None`。
pub fn get_setting(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1 LIMIT 1")?;
    let val = stmt
        .query_map(params![key], |row| row.get::<_, String>(0))?
        .next()
        .transpose()?;
    Ok(val)
}

/// 设置/更新一个键值对（Upsert 语义：存在则更新，不存在则插入）。
///
/// # Arguments
///
/// * `key` - 设置键名
/// * `value` - 设置值
pub fn set_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

/// Fetch the four TTS settings (base_url, model, voice, speed) from the DB.
/// API key retrieval is handled by the caller (OS Keychain).
pub fn get_tts_settings(
    conn: &rusqlite::Connection,
) -> Result<(String, String, String, String), AppError> {
    let keys = ["tts_base_url", "tts_model", "tts_voice", "tts_speed"];
    let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!("SELECT key, value FROM settings WHERE key IN ({placeholders})");

    let mut stmt = conn.prepare(&query)?;

    let mut map: HashMap<String, String> = stmt
        .query_map(params![keys[0], keys[1], keys[2], keys[3]], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;

    Ok((
        map.remove("tts_base_url").unwrap_or_default(),
        map.remove("tts_model").unwrap_or_default(),
        map.remove("tts_voice").unwrap_or_default(),
        map.remove("tts_speed").unwrap_or_default(),
    ))
}

// ============================================================================
// Learning Activity & Goals
// ============================================================================

/// 记录一次学习活动（打卡）。
///
/// 使用 JSON 函数在 `learning_streaks` 表中累计指定日期的活动次数。
/// 同一日期同一活动类型会累加计数。
///
/// # Arguments
///
/// * `date` - 日期字符串（YYYY-MM-DD 格式）
/// * `activity` - 学习活动类型
pub fn record_learning_activity(
    conn: &rusqlite::Connection,
    date: &str,
    activity: LearningActivity,
) -> Result<(), AppError> {
    let key = activity.as_str();
    conn.execute(
        "INSERT INTO learning_streaks (date, activities) VALUES (?1, json_set('{}', '$.' || ?2, 1)) ON CONFLICT(date) DO UPDATE SET activities = json_set(COALESCE(activities, '{}'), '$.' || ?2, COALESCE(json_extract(activities, '$.' || ?2), 0) + 1)",
        params![date, key],
    )?;
    Ok(())
}

/// 查询所有学习打卡记录（按日期倒序）。
///
/// # Returns
///
/// 每行包含日期和活动 JSON（如 `{"writing": 3, "review": 5}`）。
pub fn get_all_streaks(conn: &rusqlite::Connection) -> Result<Vec<StreakRowDto>, AppError> {
    let mut stmt =
        conn.prepare("SELECT date, activities FROM learning_streaks ORDER BY date DESC")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StreakRowDto {
                date: row.get(0)?,
                activities: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 查询指定日期的学习活动记录。
///
/// # Arguments
///
/// * `date` - 日期字符串（YYYY-MM-DD 格式）
///
/// # Returns
///
/// 活动 JSON 字符串（如 `{"writing": 3}`），该日期无记录时返回 `None`。
pub fn get_today_activities(
    conn: &rusqlite::Connection,
    date: &str,
) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT activities FROM learning_streaks WHERE date = ?1")?;
    let val = stmt
        .query_map(params![date], |row| row.get::<_, String>(0))?
        .next()
        .transpose()?;
    Ok(val)
}

/// 查询所有学习目标。
///
/// # Returns
///
/// 目标列表，每项包含目标类型和目标值。
pub fn get_learning_goals(conn: &rusqlite::Connection) -> Result<Vec<GoalDto>, AppError> {
    let mut stmt = conn.prepare("SELECT goal_type, target FROM learning_goals")?;
    let goals = stmt
        .query_map([], |row| {
            Ok(GoalDto {
                goal_type: row.get(0)?,
                target: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(goals)
}

/// 设置/更新学习目标（Upsert 语义）。
///
/// # Arguments
///
/// * `goal_type` - 目标类型（`"review"` / `"exercise"` / `"reading"` 等，经白名单校验）
/// * `target` - 目标值（如每日复习 20 个单词）
pub fn set_learning_goal(
    conn: &rusqlite::Connection,
    goal_type: &str,
    target: i64,
) -> Result<(), AppError> {
    validate_goal_type(goal_type)?;
    conn.execute(
        "INSERT INTO learning_goals (goal_type, target) VALUES (?1, ?2) ON CONFLICT(goal_type) DO UPDATE SET target = ?2",
        params![goal_type, target],
    )?;
    Ok(())
}

// ============================================================================
// Export & Backup
// ============================================================================

/// 净化 CSV 单元格：若字段以公式触发字符（= + - @）开头，前缀单引号防止 Excel/LibreOffice
/// 将其解释为公式执行（CSV Injection 防御）。
fn sanitize_csv_cell(s: &str) -> String {
    if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

/// Export all vocabulary as CSV.
pub fn export_words_csv(conn: &rusqlite::Connection) -> Result<String, AppError> {
    let mut stmt = conn.prepare(
        "SELECT word, phonetic, definition, level, source_type, notes, review_status, review_count, next_review_at, created_at FROM words ORDER BY created_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, String>(9)?,
        ))
    })?;

    let mut wtr = csv::Writer::from_writer(Vec::new());
    wtr.write_record([
        "word",
        "phonetic",
        "definition",
        "level",
        "source_type",
        "notes",
        "review_status",
        "review_count",
        "next_review_at",
        "created_at",
    ])
    .map_err(|e| AppError::Export(format!("CSV header error: {e}")))?;

    for (word, phonetic, definition, level, source_type, notes, status, count, nra, created) in
        rows.flatten()
    {
        // 对用户可控字段进行 CSV 公式注入净化
        wtr.write_record(&[
            sanitize_csv_cell(&word),
            sanitize_csv_cell(&phonetic.unwrap_or_default()),
            sanitize_csv_cell(&definition),
            sanitize_csv_cell(&level.unwrap_or_default()),
            sanitize_csv_cell(&source_type.unwrap_or_default()),
            sanitize_csv_cell(&notes.unwrap_or_default()),
            sanitize_csv_cell(&status),
            count.unwrap_or(0).to_string(),
            sanitize_csv_cell(&nra.unwrap_or_default()),
            sanitize_csv_cell(&created),
        ])
        .map_err(|e| AppError::Export(format!("CSV write error: {e}")))?;
    }

    let bytes = wtr
        .into_inner()
        .map_err(|e| AppError::Export(format!("CSV flush error: {e}")))?;
    String::from_utf8(bytes).map_err(|e| AppError::Export(format!("CSV encoding error: {e}")))
}

/// Export all vocabulary in Anki import format (tab-separated).
pub fn export_words_anki(conn: &rusqlite::Connection) -> Result<String, AppError> {
    let mut stmt = conn
        .prepare("SELECT word, phonetic, definition, notes FROM words ORDER BY created_at DESC")?;

    let mut output = String::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    for (word, phonetic, definition, notes) in rows.collect::<Result<Vec<_>, _>>()? {
        let phonetic_str = phonetic.as_deref().unwrap_or("");
        let notes_str = notes.as_deref().unwrap_or("");
        // 净化：转义 Tab/换行符防止字段错位，转义 HTML 特殊字符防止 Anki 卡片渲染异常
        let safe_word = sanitize_anki_cell(&word);
        let safe_phonetic = sanitize_anki_cell(phonetic_str);
        let safe_definition = sanitize_anki_cell(&definition);
        let safe_notes = sanitize_anki_cell(notes_str);
        output.push_str(&format!(
            "{}\t{} <br> {} <br> {}\n",
            safe_word, safe_phonetic, safe_definition, safe_notes
        ));
    }
    Ok(output)
}

/// 净化 Anki 导出单元格：将 Tab/换行符替换为空格防止字段错位，
/// 转义 HTML 特殊字符（& < >）防止 Anki 卡片渲染异常或 XSS。
/// 提取为模块级函数以便单元测试（B-14 修复）。
fn sanitize_anki_cell(s: &str) -> String {
    s.replace(['\t', '\r', '\n'], " ")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Backup the database file to the specified path.
pub fn backup_db(conn: &rusqlite::Connection, dest_path: &str) -> Result<(), AppError> {
    // 原子创建目标文件以防止 TOCTOU 竞态：create_new 在文件已存在时返回 AlreadyExists，
    // 消除了 exists() 检查与文件创建之间的时间窗口。
    let dest = std::path::Path::new(dest_path);
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dest)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Export(format!("Backup destination already exists: {dest_path}"))
            } else {
                AppError::Database(format!("Failed to create backup destination: {e}"))
            }
        })?;
    // WAL checkpoint 确保所有已提交事务写入主数据库文件
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| AppError::Database(format!("WAL checkpoint failed: {e}")))?;
    let mut dest = rusqlite::Connection::open(dest_path)
        .map_err(|e| AppError::Database(format!("Failed to open backup destination: {e}")))?;
    let backup = rusqlite::backup::Backup::new(conn, &mut dest)
        .map_err(|e| AppError::Database(format!("Backup init failed: {e}")))?;
    backup
        .run_to_completion(100, std::time::Duration::from_millis(10), None)
        .map_err(|e| AppError::Database(format!("Backup failed: {e}")))?;
    Ok(())
}

// ============================================================================
// Unit tests — 覆盖本次修复引入的纯函数逻辑（不依赖 DB / Keychain）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_review_status (B-18: 校验枚举值防止 SQL 语义被破坏) ──

    #[test]
    fn validate_review_status_accepts_valid_values() {
        assert!(validate_review_status("new").is_ok());
        assert!(validate_review_status("learning").is_ok());
        assert!(validate_review_status("mastered").is_ok());
    }

    #[test]
    fn validate_review_status_rejects_unknown_value() {
        let err = validate_review_status("archived").unwrap_err();
        assert!(
            matches!(err, AppError::Database(ref m) if m.contains("Invalid review_status")),
            "expected Database error mentioning Invalid review_status, got: {err:?}"
        );
    }

    #[test]
    fn validate_review_status_rejects_empty_string() {
        assert!(validate_review_status("").is_err());
    }

    #[test]
    fn validate_review_status_rejects_case_variants() {
        // 枚举值是大小写敏感的，"New" / "MASTERED" 都不应通过
        assert!(validate_review_status("New").is_err());
        assert!(validate_review_status("MASTERED").is_err());
    }

    // ── validate_record_type ──

    #[test]
    fn validate_record_type_accepts_all_known_types() {
        for t in [
            "correct",
            "writing",
            "reading",
            "listening",
            "speaking",
            "exercise",
        ] {
            assert!(
                validate_record_type(t).is_ok(),
                "expected '{t}' to be valid"
            );
        }
    }

    #[test]
    fn validate_record_type_rejects_unknown_value() {
        let err = validate_record_type("translate").unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
    }

    // ── validate_goal_type ──

    #[test]
    fn validate_goal_type_accepts_all_known_types() {
        for t in ["review", "exercise", "reading", "writing", "listening"] {
            assert!(validate_goal_type(t).is_ok(), "expected '{t}' to be valid");
        }
    }

    #[test]
    fn validate_goal_type_rejects_unknown_value() {
        assert!(validate_goal_type("speaking").is_err());
    }

    // ── sanitize_csv_cell (B-13: CSV 公式注入防御) ──

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_equals_prefix() {
        // 经典 CSV 注入：=CMD(...)
        assert_eq!(
            sanitize_csv_cell("=CMD|' /C calc'!A1"),
            "'=CMD|' /C calc'!A1"
        );
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_plus_prefix() {
        assert_eq!(sanitize_csv_cell("+1+1"), "'+1+1");
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_minus_prefix() {
        assert_eq!(sanitize_csv_cell("-1+1"), "'-1+1");
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_at_prefix() {
        assert_eq!(sanitize_csv_cell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
    }

    #[test]
    fn sanitize_csv_cell_leaves_safe_text_unchanged() {
        assert_eq!(sanitize_csv_cell("hello"), "hello");
        assert_eq!(sanitize_csv_cell("definition text"), "definition text");
        assert_eq!(sanitize_csv_cell(""), "");
        // 数字开头或下划线开头都不应被前缀
        assert_eq!(sanitize_csv_cell("42"), "42");
        assert_eq!(sanitize_csv_cell("_internal"), "_internal");
    }

    #[test]
    fn sanitize_csv_cell_does_not_touch_formula_in_middle() {
        // 仅以危险字符开头的字段需要净化；中间出现 = 的是正常文本
        assert_eq!(sanitize_csv_cell("a=b"), "a=b");
        assert_eq!(sanitize_csv_cell("text = value"), "text = value");
    }

    // ── sanitize_anki_cell (B-14: HTML 转义 + 字段错位防御) ──

    #[test]
    fn sanitize_anki_cell_escapes_ampersand() {
        assert_eq!(sanitize_anki_cell("Tom & Jerry"), "Tom &amp; Jerry");
    }

    #[test]
    fn sanitize_anki_cell_escapes_angle_brackets() {
        assert_eq!(sanitize_anki_cell("<script>"), "&lt;script&gt;");
        assert_eq!(sanitize_anki_cell("a<b>c"), "a&lt;b&gt;c");
    }

    #[test]
    fn sanitize_anki_cell_replaces_tab_with_space() {
        assert_eq!(sanitize_anki_cell("a\tb"), "a b");
        // 多个 Tab 都应被替换为空格，避免字段错位
        assert_eq!(sanitize_anki_cell("a\t\tb"), "a  b");
    }

    #[test]
    fn sanitize_anki_cell_replaces_newlines_with_space() {
        assert_eq!(sanitize_anki_cell("line1\nline2"), "line1 line2");
        assert_eq!(sanitize_anki_cell("line1\r\nline2"), "line1  line2");
    }

    #[test]
    fn sanitize_anki_cell_combined_injection_attempt() {
        // 混合 HTML 注入 + 字段错位尝试
        let input = "<img\tonerror=alert(1)\nsrc=x>";
        let out = sanitize_anki_cell(input);
        assert!(out.contains("&lt;img"));
        assert!(out.contains("&gt;"));
        assert!(!out.contains('\t'));
        assert!(!out.contains('\n'));
    }

    #[test]
    fn sanitize_anki_cell_preserves_safe_text() {
        assert_eq!(sanitize_anki_cell("hello world"), "hello world");
        assert_eq!(sanitize_anki_cell(""), "");
        // 不转义单引号/双引号（Anki 允许原文出现）
        assert_eq!(sanitize_anki_cell("it's \"fine\""), "it's \"fine\"");
    }

    #[test]
    fn sanitize_anki_cell_escapes_ampersand_before_brackets() {
        // 顺序很重要：& 必须先于 < > 转义，否则 &lt; 会被再次转义成 &amp;lt;
        let out = sanitize_anki_cell("&<>");
        assert_eq!(out, "&amp;&lt;&gt;");
    }
}
