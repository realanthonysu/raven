//! 键值对设置（含 TTS 配置）。

use rusqlite::params;
use std::collections::HashMap;

use crate::error::AppError;

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
        .query_map(params![key], |row| row.get::<_, String>("value"))?
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
            Ok((row.get::<_, String>("key")?, row.get::<_, String>("value")?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;

    Ok((
        map.remove("tts_base_url").unwrap_or_default(),
        map.remove("tts_model").unwrap_or_default(),
        map.remove("tts_voice").unwrap_or_default(),
        map.remove("tts_speed").unwrap_or_default(),
    ))
}
