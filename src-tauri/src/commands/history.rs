//! 学习历史记录 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_add_history` - 新增历史记录
//! - `db_get_history` - 查询历史记录（含完整字段）
//! - `db_get_history_list` - 轻量级历史列表（不含 result/graph_data）
//! - `db_get_history_by_id` - 按 ID 查询单条记录
//! - `db_delete_history` - 删除记录
//! - `db_update_history_graph_data` - 更新图表数据
//! - `db_get_recent_correct_results` - 查询最近的纠错记录

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::traits::{ReadRepository, WriteRepository};

use super::shared::{with_db, with_db_read, HistoryDto, HistoryResultDto};

// ============================================================================
// Core logic — 可独立测试的业务逻辑，接受 trait 参数
// ============================================================================

/// 将 `Vec<String>` 类型过滤转换为 `Vec<&str>` 后查询历史记录。
///
/// 前端传入 `Option<Vec<String>>`，trait 方法接受 `Option<&[&str]>`，
/// 此函数处理中间的生命周期转换。
///
/// 测试要点：类型转换正确、None 透传、空列表透传。
pub fn query_history_typed(
    repo: &impl ReadRepository,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    let types: Option<Vec<&str>> = record_types
        .as_ref()
        .map(|v| v.iter().map(String::as_str).collect());
    repo.get_history(types.as_deref(), limit, offset)
}

/// 将 `Vec<String>` 类型过滤转换为 `Vec<&str>` 后查询轻量级历史列表。
///
/// 与 [`query_history_typed`] 相同的转换逻辑，但调用 `get_history_list`。
pub fn query_history_list_typed(
    repo: &impl ReadRepository,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    let types: Option<Vec<&str>> = record_types
        .as_ref()
        .map(|v| v.iter().map(String::as_str).collect());
    repo.get_history_list(types.as_deref(), limit, offset)
}

// ============================================================================
// Tauri Command handlers — 薄委托层
// ============================================================================

/// 新增一条学习历史记录。
///
/// # Arguments
///
/// * `record_type` - 记录类型（`"correct"` / `"writing"` 等）
/// * `input_text` - 用户输入的原始文本
/// * `result` - LLM 返回的结果
/// * `graph_data` - 可选的图表数据 JSON
#[tauri::command]
pub async fn db_add_history(
    db: State<'_, Db>,
    record_type: String,
    input_text: String,
    result: String,
    graph_data: Option<String>,
) -> Result<i64, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| conn.add_history(
        &record_type,
        &input_text,
        &result,
        graph_data.as_deref(),
    ))
}

/// 查询历史记录列表（含完整字段 result 和 graph_data）。
///
/// 支持按记录类型过滤和分页。
///
/// # Arguments
///
/// * `record_types` - 可选的类型过滤列表
/// * `limit` - 每页条数
/// * `offset` - 偏移量
#[tauri::command]
pub async fn db_get_history(
    db: State<'_, Db>,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        query_history_typed(conn, record_types, limit, offset)
    })
}

/// Lightweight history list query for the HistoryPage list view.
/// Excludes the heavy `result` and `graph_data` columns that can be very large.
#[tauri::command]
pub async fn db_get_history_list(
    db: State<'_, Db>,
    record_types: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        query_history_list_typed(conn, record_types, limit, offset)
    })
}

/// 根据 ID 查询单条历史记录详情（含 result 和 graph_data）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
#[tauri::command]
pub async fn db_get_history_by_id(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<HistoryDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        conn.get_history_by_id(id)
    })
}

/// 删除指定历史记录。
///
/// # Arguments
///
/// * `id` - 要删除的记录 ID
#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| conn.delete_history(id))
}

/// 更新历史记录的图表数据（LLM 流式完成后异步回写）。
///
/// # Arguments
///
/// * `id` - 历史记录 ID
/// * `graph_data` - 图表数据 JSON 字符串
#[tauri::command]
pub async fn db_update_history_graph_data(
    db: State<'_, Db>,
    id: i64,
    graph_data: String,
) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.update_history_graph_data(id, &graph_data)
    })
}

/// Query recent correction records for the frontend's buildPersonalizedContext.
#[tauri::command]
pub async fn db_get_recent_correct_results(
    db: State<'_, Db>,
    max_records: i64,
) -> Result<Vec<String>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        conn.get_recent_correct_results(max_records)
    })
}

/// 查询最早历史记录的创建时间（Dashboard 计算使用天数）。
#[tauri::command]
pub async fn db_get_history_oldest_date(db: State<'_, Db>) -> Result<Option<String>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        conn.get_history_oldest_date()
    })
}

/// 按类型集合查询历史记录的 (id, result) 对（AnalyticsPage 按需获取）。
///
/// 返回 id 让前端与轻量记录列表按 id 精确配对，替代此前依赖返回顺序的
/// 按下标配对（P0 修复：混入 legacy "writing" 类型或两次查询间隙插入新记录时会错位）。
///
/// # Arguments
///
/// * `record_types` - 记录类型列表（如 `["correct", "writing"]` 兼容历史数据两种 type 值）
/// * `limit` - 最大返回条数
#[tauri::command]
pub async fn db_get_history_results_by_type(
    db: State<'_, Db>,
    record_types: Vec<String>,
    limit: i64,
) -> Result<Vec<HistoryResultDto>, AppError> {
    // spawn_blocking 闭包是 'static：借用无法跨闭包边界，
    // 因此把类型列表转为自有 String 后再 move 进闭包
    let types: Vec<String> = record_types.clone();
    with_db_read!(db, |conn: &rusqlite::Connection| {
        let type_refs: Vec<&str> = types.iter().map(String::as_str).collect();
        conn.get_history_results_by_type(&type_refs, limit)
    })
}

// ============================================================================
// Unit tests — mock-based testing of core logic
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::shared::test_mocks::MockReadRepo;
    use super::*;

    fn make_history(id: i64, record_type: &str) -> HistoryDto {
        HistoryDto {
            id,
            record_type: record_type.into(),
            input_text: format!("input_{id}"),
            result: format!("result_{id}"),
            graph_data: None,
            created_at: "2024-01-01".into(),
        }
    }

    #[test]
    fn query_history_typed_converts_string_types() {
        let repo = MockReadRepo {
            history: vec![make_history(1, "correct"), make_history(2, "writing")],
            ..Default::default()
        };
        let result = query_history_typed(
            &repo,
            Some(vec!["correct".into(), "writing".into()]),
            Some(10),
            Some(0),
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].record_type, "correct");
        assert_eq!(result[1].record_type, "writing");
    }

    #[test]
    fn query_history_typed_handles_none_types() {
        let repo = MockReadRepo {
            history: vec![make_history(1, "correct")],
            ..Default::default()
        };
        let result = query_history_typed(&repo, None, None, None).unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn query_history_typed_handles_empty_types() {
        let repo = MockReadRepo {
            history: vec![],
            ..Default::default()
        };
        let result = query_history_typed(&repo, Some(vec![]), Some(10), Some(0)).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn query_history_list_typed_converts_string_types() {
        let repo = MockReadRepo {
            history: vec![make_history(1, "correct")],
            ..Default::default()
        };
        let result =
            query_history_list_typed(&repo, Some(vec!["correct".into()]), Some(5), Some(0))
                .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, 1);
    }

    #[test]
    fn query_history_list_typed_handles_none_types() {
        let repo = MockReadRepo {
            history: vec![],
            ..Default::default()
        };
        let result = query_history_list_typed(&repo, None, None, None).unwrap();
        assert!(result.is_empty());
    }
}
