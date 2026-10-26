//! 学习历史记录。

use rusqlite::{OptionalExtension, params};

use crate::dto::{HistoryDto, HistoryResultDto, row_to_history};
use crate::error::AppError;

use super::{validate_difficulty_level, validate_record_type};

/// 新增一条学习历史记录。
///
/// # Arguments
///
/// * `record_type` - 记录类型（`"correct"` / `"writing"` / `"reading"` 等，经白名单校验）
/// * `input_text` - 用户输入的原始文本
/// * `result` - LLM 返回的结果文本
/// * `graph_data` - 可选的图表数据（JSON 字符串）
/// * `difficulty_level` - 可选的 CEFR 级别码（A2..C1），标记本次练习的难度档
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
    difficulty_level: Option<&str>,
) -> Result<i64, AppError> {
    validate_record_type(record_type)?;
    // 级别体系白名单：difficulty_level 为 Some 时必须是 A2..C1 之一（None 合法）
    validate_difficulty_level(difficulty_level)?;
    // 长度上限宽松（长文章/大结果合法），仅防被入侵的前端写入任意大 BLOB 导致库膨胀
    const MAX_INPUT: usize = 1_000_000;
    const MAX_RESULT: usize = 5_000_000;
    if input_text.len() > MAX_INPUT {
        return Err(AppError::Validation(format!(
            "input_text too large ({}, max {MAX_INPUT} bytes)",
            input_text.len()
        )));
    }
    if result.len() > MAX_RESULT {
        return Err(AppError::Validation(format!(
            "result too large ({}, max {MAX_RESULT} bytes)",
            result.len()
        )));
    }
    if let Some(g) = graph_data
        && g.len() > MAX_RESULT
    {
        return Err(AppError::Validation(format!(
            "graph_data too large ({}, max {MAX_RESULT} bytes)",
            g.len()
        )));
    }
    conn.execute(
        "INSERT INTO history (type, input_text, result, graph_data, difficulty_level) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![record_type, input_text, result, graph_data, difficulty_level],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Lightweight history list query for the HistoryPage list view.
/// Excludes the heavy `result` and `graph_data` columns that can be very large.
/// The list view only needs id, type, input_text, difficulty_level, and created_at.
pub fn get_history_list(
    conn: &rusqlite::Connection,
    record_types: Option<&[&str]>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    query_history(
        conn,
        "id, type, input_text, '' AS result, NULL AS graph_data, difficulty_level, created_at",
        record_types,
        limit,
        offset,
    )
}

/// 内部辅助函数：按字段列表和过滤条件查询历史记录。
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
    const ALLOWED_FIELDS: &[&str] =
        &["id, type, input_text, '' AS result, NULL AS graph_data, difficulty_level, created_at"];
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
    // limit 为 None 时默认上限 100，防止一次性加载全部历史记录导致内存压力
    let effective_limit = limit.map(|l| l.clamp(1, 500)).unwrap_or(100);
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

/// 根据 ID 查询单条历史记录（含 result，**不含 graph_data**）。
///
/// graph_data 是详情页阅读类型专属的重型列，经 [`get_history_graph_data`] 按需拉取，
/// 避免每次打开详情（含非阅读类型）都把可能数 MB 的图谱 JSON 带过 IPC。
///
/// # Returns
///
/// 匹配的记录，未找到时返回 `None`。
pub fn get_history_by_id(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, type, input_text, result, NULL AS graph_data, difficulty_level, created_at FROM history WHERE id = ?1 LIMIT 1",
    )?;
    let record = stmt
        .query_map(params![id], row_to_history)?
        .next()
        .transpose()?;
    Ok(record)
}

/// 按 ID 单独读取 graph_data（知识图谱 JSON）。
///
/// 供 HistoryDetailPage 在确认记录 type=reading 后按需调用；
/// 非阅读记录无需发起本查询。
pub fn get_history_graph_data(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT graph_data FROM history WHERE id = ?1 LIMIT 1")?;
    let data: Option<Option<String>> = stmt
        .query_row(params![id], |row| row.get::<_, Option<String>>(0))
        .optional()?;
    Ok(data.flatten())
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
    if graph_data.len() > 5_000_000 {
        return Err(AppError::Validation(format!(
            "graph_data too large ({}, max 5000000 bytes)",
            graph_data.len()
        )));
    }
    conn.execute(
        "UPDATE history SET graph_data = ?1 WHERE id = ?2",
        params![graph_data, id],
    )?;
    Ok(())
}

/// 查询最早一条历史记录的创建时间。
///
/// 用于 Dashboard 计算"已使用 N 天"，仅需单条时间戳，不传输任何记录内容。
/// 无记录时返回 `None`。
pub fn get_history_oldest_date(conn: &rusqlite::Connection) -> Result<Option<String>, AppError> {
    let mut stmt =
        conn.prepare("SELECT created_at FROM history ORDER BY created_at ASC LIMIT 1")?;
    let result = stmt
        .query_map([], |row| row.get::<_, String>("created_at"))?
        .next()
        .transpose()?;
    Ok(result)
}

/// 按类型集合查询历史记录的 (id, result) 对（不含 input_text/graph_data 等重型字段）。
///
/// 用于 AnalyticsPage 按需获取需要解析的 result 内容，避免一次性传输全部字段。
/// 返回 id 以便调用方与轻量记录列表按 id 关联 —— 此前仅返回 result 字符串，
/// 前端依赖两次查询的返回顺序一致、按下标配对，在混入 legacy type 值或查询
/// 间隙插入新记录时会整体错位。顺序按 created_at DESC。
///
/// # Arguments
///
/// * `record_types` - 记录类型集合（每个值经白名单校验）；空集合返回空列表
/// * `limit` - 最大返回条数（钳制到 1..=500）
pub fn get_history_results_by_type(
    conn: &rusqlite::Connection,
    record_types: &[&str],
    limit: i64,
) -> Result<Vec<HistoryResultDto>, AppError> {
    if record_types.is_empty() {
        return Ok(vec![]);
    }
    for t in record_types {
        validate_record_type(t)?;
    }
    let limit = limit.clamp(1, 500);
    let placeholders: Vec<&str> = record_types.iter().map(|_| "?").collect();
    let in_clause = placeholders.join(", ");
    let sql = format!(
        "SELECT id, result FROM history WHERE type IN ({in_clause}) ORDER BY created_at DESC LIMIT ?{}",
        record_types.len() + 1
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = record_types
        .iter()
        .map(|t| t as &dyn rusqlite::ToSql)
        .chain([&limit as &dyn rusqlite::ToSql])
        .collect();
    let results = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(HistoryResultDto {
                id: row.get("id")?,
                result: row.get("result")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(results)
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

// ============================================================================
// Integration tests — 使用 create_test_db() 测试完整查询逻辑
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;

    fn seed_history(conn: &rusqlite::Connection, count: usize) {
        for i in 0..count {
            let record_type = if i % 2 == 0 { "correct" } else { "writing" };
            add_history(
                conn,
                record_type,
                &format!("input_{i}"),
                &format!("result_{i}"),
                None,
                None,
            )
            .unwrap();
        }
    }

    // ── add_history ──

    #[test]
    fn add_history_returns_incrementing_id() {
        let conn = create_test_db();
        let id1 = add_history(&conn, "correct", "in1", "out1", None, None).unwrap();
        let id2 = add_history(&conn, "writing", "in2", "out2", None, None).unwrap();
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn add_history_persists_difficulty_level() {
        let conn = create_test_db();
        let id = add_history(&conn, "listening", "in", "out", None, Some("B2")).unwrap();
        let record = get_history_by_id(&conn, id).unwrap().unwrap();
        assert_eq!(record.difficulty_level.as_deref(), Some("B2"));
        // 轻量列表查询同样携带 difficulty_level（列很小，无需排除）
        let list = get_history_list(&conn, Some(&["listening"]), None, None).unwrap();
        assert_eq!(list[0].difficulty_level.as_deref(), Some("B2"));
    }

    #[test]
    fn add_history_rejects_invalid_type() {
        let conn = create_test_db();
        let result = add_history(&conn, "invalid_type", "in", "out", None, None);
        assert!(result.is_err());
    }

    #[test]
    fn add_history_accepts_all_valid_difficulty_levels() {
        let conn = create_test_db();
        for level in ["A2", "B1", "B1+", "B2", "B2+", "C1"] {
            add_history(&conn, "correct", "in", "out", None, Some(level))
                .unwrap_or_else(|e| panic!("expected '{level}' to be accepted: {e}"));
        }
    }

    #[test]
    fn add_history_rejects_invalid_difficulty_level() {
        let conn = create_test_db();
        // CEFR 六档之外的码（如 C2）与词汇等级标签（如 CET-4）都应被拒绝
        let result = add_history(&conn, "correct", "in", "out", None, Some("C2"));
        assert!(result.is_err(), "非法 difficulty_level 应被白名单拒绝");
        let result = add_history(&conn, "correct", "in", "out", None, Some("CET-4"));
        assert!(result.is_err(), "词汇等级不是 difficulty_level 的合法值");
    }

    #[test]
    fn add_history_rejects_empty_difficulty_level() {
        let conn = create_test_db();
        // difficulty_level 无清空语义：空串按非法值拒绝
        let result = add_history(&conn, "correct", "in", "out", None, Some(""));
        assert!(result.is_err(), "空串 difficulty_level 应被拒绝");
    }

    // ── get_history_list — 过滤与分页 ──

    #[test]
    fn get_history_list_returns_all_records() {
        let conn = create_test_db();
        seed_history(&conn, 5);
        let records = get_history_list(&conn, None, None, None).unwrap();
        assert_eq!(records.len(), 5);
    }

    #[test]
    fn get_history_list_filters_by_single_type() {
        let conn = create_test_db();
        seed_history(&conn, 6); // 3 correct, 3 writing
        let records = get_history_list(&conn, Some(&["correct"]), None, None).unwrap();
        assert_eq!(records.len(), 3);
        assert!(records.iter().all(|r| r.record_type == "correct"));
    }

    #[test]
    fn get_history_list_filters_by_multiple_types() {
        let conn = create_test_db();
        add_history(&conn, "correct", "a", "r", None, None).unwrap();
        add_history(&conn, "writing", "b", "r", None, None).unwrap();
        add_history(&conn, "reading", "c", "r", None, None).unwrap();
        let records = get_history_list(&conn, Some(&["correct", "writing"]), None, None).unwrap();
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn get_history_list_rejects_invalid_type() {
        let conn = create_test_db();
        add_history(&conn, "correct", "a", "r", None, None).unwrap();
        let result = get_history_list(&conn, Some(&["hacker"]), None, None);
        assert!(result.is_err(), "非法 record_type 应被白名单拒绝");
    }

    #[test]
    fn get_history_list_limit_clamps_to_500() {
        let conn = create_test_db();
        seed_history(&conn, 3);
        // Requesting limit=1000 should clamp to 500 (but we only have 3 records)
        let records = get_history_list(&conn, None, Some(1000), None).unwrap();
        assert_eq!(records.len(), 3);
    }

    #[test]
    fn get_history_list_limit_clamps_minimum_to_1() {
        let conn = create_test_db();
        seed_history(&conn, 3);
        // limit=0 should clamp to 1
        let records = get_history_list(&conn, None, Some(0), None).unwrap();
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn get_history_list_offset_works() {
        let conn = create_test_db();
        seed_history(&conn, 5);
        // Get all, then get with offset=2
        let all = get_history_list(&conn, None, None, None).unwrap();
        let offset_records = get_history_list(&conn, None, None, Some(2)).unwrap();
        assert_eq!(offset_records.len(), 3);
        assert_eq!(offset_records[0].id, all[2].id);
    }

    #[test]
    fn get_history_list_offset_negative_clamps_to_zero() {
        let conn = create_test_db();
        seed_history(&conn, 3);
        let records = get_history_list(&conn, None, None, Some(-5)).unwrap();
        assert_eq!(records.len(), 3); // Negative offset treated as 0
    }

    #[test]
    fn get_history_list_excludes_result_and_graph_data() {
        let conn = create_test_db();
        add_history(&conn, "correct", "input", "full result data", None, None).unwrap();
        let records = get_history_list(&conn, None, None, None).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].result, ""); // result should be empty string
        assert!(records[0].graph_data.is_none()); // graph_data should be None
    }

    // ── get_history_by_id ──

    #[test]
    fn get_history_by_id_returns_correct_record() {
        let conn = create_test_db();
        let id = add_history(&conn, "correct", "my input", "my result", None, None).unwrap();
        let record = get_history_by_id(&conn, id).unwrap().unwrap();
        assert_eq!(record.input_text, "my input");
        assert_eq!(record.result, "my result");
    }

    #[test]
    fn get_history_by_id_returns_none_for_missing() {
        let conn = create_test_db();
        let record = get_history_by_id(&conn, 999).unwrap();
        assert!(record.is_none());
    }

    // ── delete_history ──

    #[test]
    fn delete_history_removes_record() {
        let conn = create_test_db();
        let id = add_history(&conn, "correct", "in", "out", None, None).unwrap();
        delete_history(&conn, id).unwrap();
        let record = get_history_by_id(&conn, id).unwrap();
        assert!(record.is_none());
    }

    // ── update_history_graph_data ──

    #[test]
    fn update_history_graph_data_sets_value() {
        let conn = create_test_db();
        let id = add_history(&conn, "correct", "in", "out", None, None).unwrap();
        update_history_graph_data(&conn, id, r#"{"nodes":[],"edges":[]}"#).unwrap();
        // by_id 不再携带 graph_data；专用通道单独读取
        let graph = get_history_graph_data(&conn, id).unwrap();
        assert_eq!(graph, Some(r#"{"nodes":[],"edges":[]}"#.to_string()));
        let record = get_history_by_id(&conn, id).unwrap().unwrap();
        assert!(record.graph_data.is_none());
    }

    #[test]
    fn get_history_by_id_excludes_graph_data() {
        let conn = create_test_db();
        let id = add_history(
            &conn,
            "reading",
            "in",
            "out",
            Some(r#"{"nodes":[1],"edges":[]}"#),
            None,
        )
        .unwrap();
        let record = get_history_by_id(&conn, id).unwrap().unwrap();
        assert!(record.graph_data.is_none());
        assert_eq!(
            get_history_graph_data(&conn, id).unwrap(),
            Some(r#"{"nodes":[1],"edges":[]}"#.to_string())
        );
    }

    // ── get_history_results_by_type ──

    #[test]
    fn results_by_type_returns_id_and_result_pairs() {
        let conn = create_test_db();
        add_history(&conn, "correct", "a", "result_a", None, None).unwrap();
        add_history(&conn, "writing", "b", "result_b", None, None).unwrap();
        add_history(&conn, "reading", "c", "result_c", None, None).unwrap();

        // 多类型过滤（correct + legacy writing），返回 (id, result) 对
        let results = get_history_results_by_type(&conn, &["correct", "writing"], 10).unwrap();
        assert_eq!(results.len(), 2);
        let by_id: std::collections::HashMap<i64, &str> =
            results.iter().map(|r| (r.id, r.result.as_str())).collect();
        assert_eq!(by_id.get(&1), Some(&"result_a"));
        assert_eq!(by_id.get(&2), Some(&"result_b"));
    }

    #[test]
    fn results_by_type_empty_types_returns_empty() {
        let conn = create_test_db();
        seed_history(&conn, 3);
        let results = get_history_results_by_type(&conn, &[], 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn results_by_type_rejects_invalid_type() {
        let conn = create_test_db();
        let result = get_history_results_by_type(&conn, &["correct", "invalid"], 10);
        assert!(result.is_err());
    }

    #[test]
    fn results_by_type_respects_limit() {
        let conn = create_test_db();
        seed_history(&conn, 5);
        let results = get_history_results_by_type(&conn, &["correct", "writing"], 3).unwrap();
        assert_eq!(results.len(), 3);
        // 返回的 id 均来自已插入的 5 条记录
        assert!(results.iter().all(|r| (1..=5).contains(&r.id)));
    }

    // ── get_recent_correct_results ──

    #[test]
    fn get_recent_correct_results_returns_correct_and_writing() {
        let conn = create_test_db();
        add_history(&conn, "correct", "a", "result_a", None, None).unwrap();
        add_history(&conn, "writing", "b", "result_b", None, None).unwrap();
        add_history(&conn, "reading", "c", "result_c", None, None).unwrap();
        let results = get_recent_correct_results(&conn, 10).unwrap();
        assert_eq!(results.len(), 2); // Only correct and writing
    }

    #[test]
    fn get_recent_correct_results_respects_limit() {
        let conn = create_test_db();
        seed_history(&conn, 10);
        let results = get_recent_correct_results(&conn, 3).unwrap();
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn get_recent_correct_results_clamps_limit() {
        let conn = create_test_db();
        seed_history(&conn, 5);
        // limit=0 clamps to 1
        let results = get_recent_correct_results(&conn, 0).unwrap();
        assert_eq!(results.len(), 1);
    }
}
