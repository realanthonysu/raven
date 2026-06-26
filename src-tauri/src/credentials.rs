//! OS Keychain 凭据存储 —— 替代前端 Base64 混淆。
//!
//! 使用操作系统的原生密钥管理服务：
//! - Windows: Credential Manager
//! - macOS: Keychain
//! - Linux: Secret Service (GNOME Keyring / KWallet)
//!
//! 每个模型配置的 API Key 以 "model_{id}" 为账户名存储在 "raven" 服务下。
//! TTS API Key 以 "tts" 为账户名存储。
//!
//! 安全性优势：
//! - 密钥不再以明文或 Base64 存储在 SQLite 中
//! - 前端代码无法直接读取原始密钥
//! - 即使数据库文件泄露，也无法获取 API Key

use crate::error::AppError;

/// Keychain 服务名称，所有凭据均存储在此服务标识下。
const SERVICE_NAME: &str = "raven";

/// 将 API Key 存入 OS Keychain。
///
/// 账户名格式为 `model_{model_id}`，服务名为 `"raven"`。
///
/// # Arguments
///
/// * `model_id` - 模型配置 ID
/// * `key` - 要存储的 API Key 明文
///
/// # Errors
///
/// 当 Keychain 操作失败时返回 `AppError::Credential`。
pub fn store_key(model_id: i64, key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))?;
    entry
        .set_password(key)
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))
}

/// 从 OS Keychain 读取 API Key。
///
/// # Arguments
///
/// * `model_id` - 模型配置 ID
///
/// # Returns
///
/// - `Ok(Some(key))` - 找到并返回 API Key
/// - `Ok(None)` - 未找到（新模型或从未存储）
/// - `Err(AppError::Credential)` - Keychain 操作失败
pub fn get_key(model_id: i64) -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Credential(format!("keyring get error: {e}"))),
    }
}

/// 删除 OS Keychain 中的 API Key（模型删除时调用）。
///
/// 如果 Keychain 条目不存在（`NoEntry`），视为成功（幂等删除）。
///
/// # Arguments
///
/// * `model_id` - 模型配置 ID
pub fn delete_key(model_id: i64) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 不存在也算成功
        Err(e) => Err(AppError::Credential(format!("keyring delete error: {e}"))),
    }
}

/// 存储 TTS API Key 到 OS Keychain。
///
/// 账户名为固定值 `"tts"`，服务名为 `"raven"`。
///
/// # Arguments
///
/// * `key` - TTS API Key 明文
pub fn store_tts_key(key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")?;
    entry
        .set_password(key)
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))
}

/// 从 OS Keychain 读取 TTS API Key。
///
/// # Returns
///
/// - `Ok(Some(key))` - 找到并返回 TTS API Key
/// - `Ok(None)` - 未找到
/// - `Err(AppError::Credential)` - Keychain 操作失败
pub fn get_tts_key() -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Credential(format!("keyring get error: {e}"))),
    }
}

/// 删除 OS Keychain 中的 TTS API Key。
///
/// 如果 Keychain 条目不存在（`NoEntry`），视为成功（幂等删除）。
pub fn delete_tts_key() -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 不存在也算成功
        Err(e) => Err(AppError::Credential(format!("keyring delete error: {e}"))),
    }
}
