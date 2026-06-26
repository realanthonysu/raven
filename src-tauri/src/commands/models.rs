//! 模型配置 CRUD Tauri Command（含 OS Keychain 集成）。
//!
//! 提供以下前端可调用的 Command：
//! - `get_models` - 获取模型列表（不含 API Key）
//! - `add_model` - 新增模型
//! - `delete_model` - 删除模型
//! - `get_default_model` - 获取默认模型（含 API Key）
//! - `set_default_model` - 设置默认模型
//! - `update_model` - 更新模型配置
//! - `get_model_api_key` - 单独获取模型 API Key

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, ModelDto, NewModelInput};

/// 获取所有模型配置列表（不含 API Key，按默认模型优先排序）。
#[tauri::command]
pub async fn get_models(db: State<'_, Db>) -> Result<Vec<ModelDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_models(
        conn
    ))
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
pub async fn add_model(db: State<'_, Db>, model: NewModelInput) -> Result<i64, AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| repository::add_model(
        conn, &model
    ))
}

/// 删除指定模型配置（同时清理 OS Keychain 中的 API Key）。
///
/// # Arguments
///
/// * `id` - 要删除的模型 ID
#[tauri::command]
pub async fn delete_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::delete_model(
        conn, id
    ))
}

/// 获取默认模型（含 API Key，从 OS Keychain 读取）。
///
/// 如果没有标记为默认的模型，则回退返回 ID 最小的模型。
#[tauri::command]
pub async fn get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        if let Some(m) = repository::get_default_model(conn)? {
            return Ok(Some(m));
        }
        repository::get_first_model(conn)
    })
}

/// 设置指定模型为默认模型（清除其他模型的默认标记）。
///
/// # Arguments
///
/// * `id` - 要设为默认的模型 ID
#[tauri::command]
pub async fn set_default_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::set_default_model(conn, id)
    })
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
pub async fn update_model(
    db: State<'_, Db>,
    id: i64,
    name: String,
    base_url: String,
    model_name: String,
    api_key: String,
    is_default: bool,
) -> Result<(), AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| {
        repository::update_model(
            conn,
            id,
            &name,
            &base_url,
            &model_name,
            &api_key,
            is_default,
        )
    })
}

/// P2-3: 单独获取模型 API Key（编辑模型时使用，列表接口不再返回密钥）
#[tauri::command]
pub async fn get_model_api_key(id: i64) -> Result<String, AppError> {
    repository::get_model_api_key(id)
}
