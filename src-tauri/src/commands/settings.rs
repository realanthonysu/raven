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
use crate::repository::traits::{ReadRepository, WriteRepository};

use super::shared::{with_db, with_db_read, TtsConfigDto};

/// Settings 表 key 白名单（统一）。
///
/// `db_set_setting` 和 `db_set_tts_setting` 共用此白名单，防止前端插入任意键值对。
/// 新增设置项时只需在此处添加一行。
const ALLOWED_SETTINGS: &[&str] = &[
    // 通用设置
    "onboarding_done",
    "asr_model",
    "last_backup_time",
    "last_backup_path",
    "notification_enabled",
    "last_notification_date",
    "review_notify_time",
    // TTS 设置
    "tts_base_url",
    "tts_model",
    "tts_voice",
    "tts_speed",
];

// ============================================================================
// Core logic — 可独立测试的业务逻辑，接受 trait 参数
// ============================================================================

/// 验证设置键是否在白名单中。
///
/// 测试要点：允许的键通过，未知键被拒绝。
pub fn validate_setting_key(key: &str) -> Result<(), AppError> {
    if !ALLOWED_SETTINGS.contains(&key) {
        return Err(AppError::Database(format!(
            "Invalid setting key: '{key}'. Allowed: {}",
            ALLOWED_SETTINGS.join(", ")
        )));
    }
    Ok(())
}

/// 构建完整 TTS 配置：从 DB 读取设置 + 从 Keychain 读取 API Key + 应用默认值。
///
/// 测试要点：空值应用默认值，Keychain 失败降级为空 Key。
pub fn build_tts_config(
    repo: &impl ReadRepository,
    get_tts_key: impl Fn() -> Result<Option<String>, AppError>,
) -> Result<TtsConfigDto, AppError> {
    let (base_url, model, voice, speed_str) = repo.get_tts_settings()?;

    // Keychain 读取失败时记录日志并降级为空 Key，避免阻塞用户使用
    let api_key = match get_tts_key() {
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

/// 处理 TTS 设置写入：`tts_api_key` 路由到 Keychain，其余写入 DB。
///
/// 测试要点：api_key 路由到 store/delete，非 api_key 写入 DB，无效键被拒绝。
pub fn handle_set_tts_setting(
    repo: &mut impl WriteRepository,
    store_tts_key: impl Fn(&str) -> Result<(), AppError>,
    delete_tts_key: impl Fn() -> Result<(), AppError>,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    if key == "tts_api_key" {
        if value.is_empty() {
            delete_tts_key()?;
        } else {
            store_tts_key(value)?;
        }
    } else {
        validate_setting_key(key)?;
        repo.set_setting(key, value)?;
    }
    Ok(())
}

// ============================================================================
// Tauri Command handlers — 薄委托层
// ============================================================================

/// 查询单个设置项的值。
///
/// 与 `db_set_setting` 对称，读取同样经过白名单校验，
/// 防止前端探测 settings 表中的任意键。
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
    validate_setting_key(&key)?;
    with_db_read!(db, |conn: &rusqlite::Connection| conn.get_setting(&key))
}

/// 设置/更新一个键值对（Upsert 语义：存在则更新，不存在则插入）。
///
/// # Arguments
///
/// * `key` - 设置键名
/// * `value` - 设置值
#[tauri::command]
pub async fn db_set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), AppError> {
    validate_setting_key(&key)?;
    with_db!(db, |conn: &rusqlite::Connection| conn
        .set_setting(&key, &value))
}

/// 获取完整的 TTS 配置（base_url、model、voice、speed、api_key）。
///
/// API Key 从 OS Keychain 读取，Keychain 失败时降级为空字符串。
/// 未设置的配置项使用默认值（OpenAI TTS-1、alloy 语音、1.0x 速度）。
#[tauri::command]
pub async fn db_get_tts_config(db: State<'_, Db>) -> Result<TtsConfigDto, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| {
        build_tts_config(conn, credentials::get_tts_key)
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
    with_db!(db, |conn: &mut rusqlite::Connection| {
        handle_set_tts_setting(
            conn,
            credentials::store_tts_key,
            credentials::delete_tts_key,
            &key,
            &value,
        )
    })
}

// ============================================================================
// Unit tests — mock-based testing of core logic
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::shared::test_mocks::{MockReadRepo, MockWriteRepo};
    use super::*;
    use std::cell::Cell;

    #[test]
    fn validate_setting_key_accepts_allowed_key() {
        assert!(validate_setting_key("onboarding_done").is_ok());
        assert!(validate_setting_key("tts_model").is_ok());
    }

    #[test]
    fn validate_setting_key_rejects_unknown_key() {
        let result = validate_setting_key("evil_key");
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("evil_key"));
    }

    #[test]
    fn build_tts_config_applies_defaults_for_empty_settings() {
        let repo = MockReadRepo {
            tts_settings: Some((String::new(), String::new(), String::new(), String::new())),
            ..Default::default()
        };
        let config = build_tts_config(&repo, || Ok(None)).unwrap();
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert_eq!(config.model, "tts-1");
        assert_eq!(config.voice, "alloy");
        assert_eq!(config.speed, 1.0);
        assert_eq!(config.api_key, "");
    }

    #[test]
    fn build_tts_config_uses_provided_values() {
        let repo = MockReadRepo {
            tts_settings: Some((
                "https://custom.api".into(),
                "tts-2".into(),
                "nova".into(),
                "1.5".into(),
            )),
            ..Default::default()
        };
        let config = build_tts_config(&repo, || Ok(Some("my-key".into()))).unwrap();
        assert_eq!(config.base_url, "https://custom.api");
        assert_eq!(config.model, "tts-2");
        assert_eq!(config.voice, "nova");
        assert_eq!(config.speed, 1.5);
        assert_eq!(config.api_key, "my-key");
    }

    #[test]
    fn build_tts_config_degrades_on_keychain_error() {
        let repo = MockReadRepo {
            tts_settings: Some((
                "https://api.test".into(),
                "m".into(),
                "v".into(),
                "1.0".into(),
            )),
            ..Default::default()
        };
        let config = build_tts_config(&repo, || {
            Err(AppError::Credential("keychain unavailable".into()))
        })
        .unwrap();
        assert_eq!(config.api_key, "");
    }

    #[test]
    fn handle_set_tts_setting_routes_api_key_to_keychain() {
        let mut repo = MockWriteRepo::new(MockReadRepo::default());
        let stored = Cell::new(false);

        handle_set_tts_setting(
            &mut repo,
            |_key: &str| {
                stored.set(true);
                Ok(())
            },
            || Ok(()),
            "tts_api_key",
            "test-key",
        )
        .unwrap();

        assert!(stored.get());
    }

    #[test]
    fn handle_set_tts_setting_deletes_empty_api_key() {
        let mut repo = MockWriteRepo::new(MockReadRepo::default());
        let deleted = Cell::new(false);

        handle_set_tts_setting(
            &mut repo,
            |_key: &str| Ok(()),
            || {
                deleted.set(true);
                Ok(())
            },
            "tts_api_key",
            "",
        )
        .unwrap();

        assert!(deleted.get());
    }

    #[test]
    fn handle_set_tts_setting_writes_non_api_key_to_db() {
        let mut repo = MockWriteRepo::new(MockReadRepo::default());

        handle_set_tts_setting(
            &mut repo,
            |_key: &str| Ok(()),
            || Ok(()),
            "tts_model",
            "tts-2",
        )
        .unwrap();
    }

    #[test]
    fn handle_set_tts_setting_rejects_invalid_key() {
        let mut repo = MockWriteRepo::new(MockReadRepo::default());

        let result = handle_set_tts_setting(
            &mut repo,
            |_key: &str| Ok(()),
            || Ok(()),
            "invalid_key",
            "value",
        );

        assert!(result.is_err());
    }
}
