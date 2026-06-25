/// Settings and TTS configuration commands.
use tauri::State;

use crate::credentials;
use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, TtsConfigDto};

#[tauri::command]
pub async fn db_get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_setting(
        conn, &key
    ))
}

#[tauri::command]
pub async fn db_set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::set_setting(
        conn, &key, &value
    ))
}

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
