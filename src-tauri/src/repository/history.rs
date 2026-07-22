//! 学习历史记录。

use rusqlite::params;

use crate::commands::shared::{row_to_history, HistoryDto};
use crate::error::AppError;

use super::validate_record_type;

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
/// H-2: limit 钳制到 1..=500，offset 钳制到 >= 0，防止恶意/异常大值导致 OOM。
/// M-7: fields 参数使用白名单校验，防止 SQL 注入（虽然当前调用方传入硬编码字符串）。
fn query_history(
    conn: &rusqlite::Connection,
    fields: &str,
    record_types: Option<&[&str]>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    // M-7: 白名单校验 fields 参数，只允许已知的列组合
    const ALLOWED_FIELDS: &[&str] = &[
        "id, type, input_text, result, graph_data, created_at",
        "id, type, input_text, '', NULL, created_at",
    ];
    if !ALLOWED_FIELDS.contains(&fields) {
        return Err(AppError::Database(format!(
            "Invalid fields parameter: '{fields}'"
        )));
    }

    if let Some(types) = record_types {
        for t in types {
            validate_record_type(t)?;
        }
    }
    let effective_limit = limit.map(|l| l.clamp(1, 500)).unwrap_or(-1);
    let effective_offset = offset.unwrap_or(0).max(0);

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
/// H-2: max_records 钳制到 1..=200，防止恶意/异常大值导致 OOM。
pub fn get_recent_correct_results(
    conn: &rusqlite::Connection,
    max_records: i64,
) -> Result<Vec<String>, AppError> {
    let max_records = max_records.clamp(1, 200);
    let mut stmt = conn.prepare(
        "SELECT result FROM history WHERE type IN ('correct', 'writing') ORDER BY created_at DESC LIMIT ?1",
    )?;
    let results = stmt
        .query_map(params![max_records], |row| row.get::<_, String>("result"))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(results)
}
