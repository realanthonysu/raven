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

// ============================================================================
// Integration tests — 使用 create_test_db() 测试键值对 CRUD 和 TTS 配置
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;

    // ── get_setting / set_setting ──

    #[test]
    fn get_setting_returns_none_for_missing_key() {
        let conn = create_test_db();
        let val = get_setting(&conn, "nonexistent").unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn set_setting_then_get_setting() {
        let conn = create_test_db();
        set_setting(&conn, "theme", "dark").unwrap();
        let val = get_setting(&conn, "theme").unwrap();
        assert_eq!(val, Some("dark".to_string()));
    }

    #[test]
    fn set_setting_upserts_existing_key() {
        let conn = create_test_db();
        set_setting(&conn, "theme", "dark").unwrap();
        set_setting(&conn, "theme", "light").unwrap();
        let val = get_setting(&conn, "theme").unwrap();
        assert_eq!(val, Some("light".to_string()));
    }

    #[test]
    fn set_setting_multiple_keys_independent() {
        let conn = create_test_db();
        set_setting(&conn, "key1", "val1").unwrap();
        set_setting(&conn, "key2", "val2").unwrap();
        assert_eq!(
            get_setting(&conn, "key1").unwrap(),
            Some("val1".to_string())
        );
        assert_eq!(
            get_setting(&conn, "key2").unwrap(),
            Some("val2".to_string())
        );
    }

    // ── get_tts_settings ──

    #[test]
    fn get_tts_settings_returns_defaults_when_empty() {
        let conn = create_test_db();
        let (base_url, model, voice, speed) = get_tts_settings(&conn).unwrap();
        assert_eq!(base_url, "");
        assert_eq!(model, "");
        assert_eq!(voice, "");
        assert_eq!(speed, "");
    }

    #[test]
    fn get_tts_settings_returns_configured_values() {
        let conn = create_test_db();
        set_setting(&conn, "tts_base_url", "https://api.example.com").unwrap();
        set_setting(&conn, "tts_model", "tts-1").unwrap();
        set_setting(&conn, "tts_voice", "alloy").unwrap();
        set_setting(&conn, "tts_speed", "1.5").unwrap();

        let (base_url, model, voice, speed) = get_tts_settings(&conn).unwrap();
        assert_eq!(base_url, "https://api.example.com");
        assert_eq!(model, "tts-1");
        assert_eq!(voice, "alloy");
        assert_eq!(speed, "1.5");
    }

    #[test]
    fn get_tts_settings_partial_config() {
        let conn = create_test_db();
        set_setting(&conn, "tts_voice", "nova").unwrap();
        // Only voice set, others default to empty
        let (base_url, model, voice, speed) = get_tts_settings(&conn).unwrap();
        assert_eq!(base_url, "");
        assert_eq!(model, "");
        assert_eq!(voice, "nova");
        assert_eq!(speed, "");
    }
}
