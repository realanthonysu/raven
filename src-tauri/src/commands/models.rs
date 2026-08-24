//! 模型配置 CRUD Tauri Command（含 OS Keychain 集成）。
//!
//! 提供以下前端可调用的 Command：
//! - `db_get_models` - 获取模型列表（不含 API Key）
//! - `db_add_model` - 新增模型
//! - `db_delete_model` - 删除模型
//! - `db_get_default_model` - 获取默认模型（含 API Key）
//! - `db_set_default_model` - 设置默认模型
//! - `db_update_model` - 更新模型配置

use tauri::State;

use crate::credentials;
use crate::db::Db;
use crate::error::AppError;
use crate::repository::models;

use super::shared::{with_db, with_db_read, ModelDto, NewModelInput};

// ============================================================================
// Core logic — 可独立测试的业务逻辑
// ============================================================================

/// 解析默认模型：优先返回标记为默认的模型，无则回退到 ID 最小的模型。
///
/// 测试要点：fallback 链（default → first → None）。
pub fn resolve_default_model(conn: &rusqlite::Connection) -> Result<Option<ModelDto>, AppError> {
    if let Some(m) = models::get_default_model(conn)? {
        return Ok(Some(m));
    }
    models::get_first_model(conn)
}

// ============================================================================
// Tauri Command handlers — 薄委托层
// ============================================================================

/// 获取所有模型配置列表（不含 API Key，按默认模型优先排序）。
#[tauri::command]
pub async fn db_get_models(db: State<'_, Db>) -> Result<Vec<ModelDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| models::get_models(conn))
}

/// 新增模型配置。
///
/// API Key 在 DB 事务提交后写入 OS Keychain。
///
/// # Arguments
///
/// * `model` - 新模型的输入参数（名称、Base URL、模型名、API Key 等）
///
/// # Returns
///
/// 新插入模型的 ID。
#[tauri::command]
pub async fn db_add_model(db: State<'_, Db>, model: NewModelInput) -> Result<i64, AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| models::add_model(
        conn, &model
    ))
}

/// 删除指定模型配置（同时清理 OS Keychain 中的 API Key）。
///
/// # Arguments
///
/// * `id` - 要删除的模型 ID
#[tauri::command]
pub async fn db_delete_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| models::delete_model(
        conn, id
    ))
}

/// 获取默认模型（含 API Key，从 OS Keychain 读取）。
///
/// 如果没有标记为默认的模型，则回退返回 ID 最小的模型。
#[tauri::command]
pub async fn db_get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| resolve_default_model(
        conn
    ))
}

/// 设置指定模型为默认模型（清除其他模型的默认标记）。
///
/// # Arguments
///
/// * `id` - 要设为默认的模型 ID
#[tauri::command]
pub async fn db_set_default_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| models::set_default_model(
        conn, id
    ))
}

/// 获取指定模型的 API Key（从 OS Keychain 读取）。
///
/// 前端编辑模型时需要此命令来预填 API Key 字段。
/// 列表接口（db_get_models）出于安全不返回 API Key。
///
/// 密钥下发豁免：见 commands/proxy.rs 模块文档的豁免清单（条目 1）。
///
/// Keychain 读取不经过数据库——此命令不需要 DB 连接。
/// Keychain 失败时降级为空字符串（与 `get_default_model` 的预填语义一致）。
#[tauri::command]
pub async fn get_model_api_key(id: i64) -> Result<String, AppError> {
    Ok(credentials::get_key_or_empty(id))
}

/// 更新模型配置（名称、Base URL、模型名、API Key、默认状态）。
///
/// # Arguments
///
/// * `id` - 模型 ID
/// * `name` - 显示名称
/// * `base_url` - API Base URL
/// * `model_name` - 模型标识符
/// * `api_key` - API Key（写入 OS Keychain，空值表示不更新）
/// * `is_default` - 是否设为默认模型
#[tauri::command]
pub async fn db_update_model(
    db: State<'_, Db>,
    id: i64,
    name: String,
    base_url: String,
    model_name: String,
    api_key: String,
    is_default: bool,
) -> Result<(), AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| models::update_model(
        conn,
        id,
        &name,
        &base_url,
        &model_name,
        &api_key,
        is_default
    ))
}

// ============================================================================
// Unit tests — 内存数据库上的核心逻辑测试（绕过 Keychain）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;
    use rusqlite::params;

    /// 直接向 models 表插入一条记录（绕过 add_model 的 Keychain 写入）。
    fn insert_model(conn: &rusqlite::Connection, name: &str, is_default: bool) -> i64 {
        conn.execute(
            "INSERT INTO models (name, base_url, model_name, is_default) VALUES (?1, ?2, ?3, ?4)",
            params![name, "https://api.openai.com/v1", "gpt-4", is_default],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn resolve_default_model_returns_default_when_present() {
        let conn = create_test_db();
        let _fallback = insert_model(&conn, "first-model", false);
        let default_id = insert_model(&conn, "default", true);

        let result = resolve_default_model(&conn).unwrap().unwrap();
        assert_eq!(result.id, default_id);
        assert_eq!(result.name, "default");
    }

    #[test]
    fn resolve_default_model_falls_back_to_first() {
        let conn = create_test_db();
        let first_id = insert_model(&conn, "first-model", false);
        insert_model(&conn, "later-model", false);

        let result = resolve_default_model(&conn).unwrap().unwrap();
        assert_eq!(result.id, first_id);
        assert_eq!(result.name, "first-model");
    }

    #[test]
    fn resolve_default_model_returns_none_when_empty() {
        let conn = create_test_db();
        let result = resolve_default_model(&conn).unwrap();
        assert!(result.is_none());
    }
}
