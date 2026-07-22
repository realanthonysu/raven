//! 模型配置 CRUD（API Key 存储在 OS Keychain）。

use rusqlite::params;

use crate::commands::shared::{ModelDto, NewModelInput};
use crate::credentials;
use crate::error::AppError;

use super::get_api_key_or_empty;

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
    let models: Vec<ModelDto> = stmt
        .query_map([], |row| {
            Ok(ModelDto {
                id: row.get("id")?,
                name: row.get("name")?,
                api_key: String::new(), // P2-3: 列表接口不返回 api_key
                base_url: row.get("base_url")?,
                model_name: row.get("model_name")?,
                is_default: row.get("is_default")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
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
/// M-6: 校验模型输入字段非空且长度合理。
pub fn add_model(conn: &mut rusqlite::Connection, model: &NewModelInput) -> Result<i64, AppError> {
    if model.name.trim().is_empty() {
        return Err(AppError::Database("model name cannot be empty".to_string()));
    }
    if model.base_url.trim().is_empty() {
        return Err(AppError::Database("base_url cannot be empty".to_string()));
    }
    if model.model_name.trim().is_empty() {
        return Err(AppError::Database("model_name cannot be empty".to_string()));
    }
    if model.name.len() > 500 || model.base_url.len() > 2000 || model.model_name.len() > 200 {
        return Err(AppError::Database("input field too long".to_string()));
    }
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
            if let Err(del_err) = conn.execute("DELETE FROM models WHERE id = ?1", params![new_id])
            {
                tracing::error!(error = %del_err, model_id = new_id, "compensation delete also failed — orphan model row may remain");
            }
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

/// Primary query for the default model (`is_default = 1`).
/// Returns `None` when no model is flagged as default; the caller is expected
/// to fall back to [`get_first_model`].
pub fn get_default_model(conn: &rusqlite::Connection) -> Result<Option<ModelDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, base_url, model_name, is_default FROM models WHERE is_default = 1 LIMIT 1",
    )?;

    let result = stmt
        .query_map([], |row| {
            let id: i64 = row.get("id")?;
            Ok(ModelDto {
                id,
                name: row.get("name")?,
                api_key: get_api_key_or_empty(id),
                base_url: row.get("base_url")?,
                model_name: row.get("model_name")?,
                is_default: row.get("is_default")?,
            })
        })?
        .next()
        .transpose()?;

    Ok(result)
}

/// Fallback query: return the model with the lowest id.
pub fn get_first_model(conn: &rusqlite::Connection) -> Result<Option<ModelDto>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, base_url, model_name, is_default FROM models ORDER BY id ASC LIMIT 1",
    )?;
    let result = stmt
        .query_map([], |row| {
            let id: i64 = row.get("id")?;
            Ok(ModelDto {
                id,
                name: row.get("name")?,
                api_key: get_api_key_or_empty(id),
                base_url: row.get("base_url")?,
                model_name: row.get("model_name")?,
                is_default: row.get("is_default")?,
            })
        })?
        .next()
        .transpose()?;

    Ok(result)
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

    // 始终更新 is_default 列，支持取消默认状态
    if is_default {
        // 设为默认：清除其他模型的默认标记，仅保留当前模型
        tx.execute(
            "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![id],
        )?;
    } else {
        // 取消默认：仅清除当前模型的默认标记，不影响其他模型
        tx.execute(
            "UPDATE models SET is_default = 0 WHERE id = ?1",
            params![id],
        )?;
    }

    // 先提交 DB 事务，再写 Keychain
    tx.commit()?;

    // 提交成功后写 Keychain；若失败返回错误，让前端知道 API Key 未生效
    if !api_key.is_empty() {
        if let Err(e) = credentials::store_key(id, api_key) {
            tracing::error!(error = %e, model_id = id, "store_key failed after update_model commit");
            return Err(e);
        }
    }

    Ok(())
}
