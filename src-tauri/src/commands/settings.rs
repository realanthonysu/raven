//! 设置与 TTS 配置 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_get_setting` - 查询单个设置项
//! - `db_set_setting` - 设置/更新键值对
//! - `db_get_tts_config` - 获取完整 TTS 配置（含 Keychain 中的 API Key）
//! - `db_set_tts_setting` - 设置单个 TTS 配置项（API Key 存入 Keychain）

use tauri::State;

use crate::credentials;
use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, TtsConfigDto};

/// 查询单个设置项的值。
///
/// # Arguments
///
/// * `key` - 设置键名
///
/// # Returns
///
/// 设置值，不存在时返回 `None`。
#[tauri::command]
pub async fn db_get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_setting(
        conn, &key
    ))
}

/// 设置/更新一个键值对（Upsert 语义：存在则更新，不存在则插入）。
///
/// # Arguments
///
/// * `key` - 设置键名
/// * `value` - 设置值
#[tauri::command]
pub async fn db_set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::set_setting(
        conn, &key, &value
    ))
}

/// 获取完整的 TTS 配置（base_url、model、voice、speed、api_key）。
///
/// API Key 从 OS Keychain 读取，Keychain 失败时降级为空字符串。
/// 未设置的配置项使用默认值（OpenAI TTS-1、alloy 语音、1.0x 速度）。
#[tauri::command]
pub async fn db_get_tts_config(db: State<'_, Db>) -> Result<TtsConfigDto, AppError> {
    let (base_url, model, voice, speed_str) = with_db!(db, |conn: &rusqlite::Connection| {
        repository::get_tts_settings(conn)
    })?;

    // Keychain 读取失败时记录日志并降级为空 Key，避免阻塞用户使用
    let api_key = match credentials::get_tts_key() {
        Ok(Some(k)) => k,
        Ok(None) => String::new(),
        Err(e) => {
            tracing::warn!(error = %e, "failed to read TTS keychain entry");
            String::new()
        }
    };

    Ok(TtsConfigDto {
        base_url: if base_url.is_empty() {
            "https://api.openai.com/v1".into()
        } else {
            base_url
        },
        api_key,
        model: if model.is_empty() {
            "tts-1".into()
        } else {
            model
        },
        voice: if voice.is_empty() {
            "alloy".into()
        } else {
            voice
        },
        speed: speed_str.parse::<f64>().unwrap_or(1.0),
    })
}

/// 设置单个 TTS 配置项。
///
/// 当 `key` 为 `"tts_api_key"` 时，API Key 存入 OS Keychain 而非数据库。
/// 空值表示清除 TTS API Key。
///
/// # Arguments
///
/// * `key` - 配置键名（`"tts_base_url"` / `"tts_model"` / `"tts_voice"` / `"tts_speed"` / `"tts_api_key"`）
/// * `value` - 配置值
#[tauri::command]
pub async fn db_set_tts_setting(
    db: State<'_, Db>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    if key == "tts_api_key" {
        if value.is_empty() {
            // 空值表示清除 TTS Key，删除 Keychain 条目避免残留
            credentials::delete_tts_key()?;
        } else {
            credentials::store_tts_key(&value)?;
        }
    } else {
        with_db!(db, |conn: &rusqlite::Connection| {
            repository::set_setting(conn, &key, &value)
        })?;
    }
    Ok(())
}
