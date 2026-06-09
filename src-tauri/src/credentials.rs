/// OS Keychain 凭据存储 —— 替代前端 Base64 混淆。
///
/// 使用操作系统的原生密钥管理服务：
/// - Windows: Credential Manager
/// - macOS: Keychain
/// - Linux: Secret Service (GNOME Keyring / KWallet)
///
/// 每个模型配置的 API Key 以 "model_{id}" 为账户名存储在 "raven" 服务下。
/// TTS API Key 以 "tts" 为账户名存储。
///
/// 安全性优势：
/// - 密钥不再以明文或 Base64 存储在 SQLite 中
/// - 前端代码无法直接读取原始密钥
/// - 即使数据库文件泄露，也无法获取 API Key
use crate::error::AppError;

const SERVICE_NAME: &str = "raven";

/// 将 API Key 存入 OS Keychain。
pub fn store_key(model_id: i64, key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))
        .map_err(|e| AppError::Credential(format!("keyring entry error: {e}")))?;
    entry
        .set_password(key)
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))
}

/// 从 OS Keychain 读取 API Key。
/// 返回 None 表示未找到（新模型或从未存储）。
pub fn get_key(model_id: i64) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))
        .map_err(|e| format!("keyring entry error: {e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}

/// 删除 OS Keychain 中的 API Key（模型删除时调用）。
pub fn delete_key(model_id: i64) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))
        .map_err(|e| format!("keyring entry error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 不存在也算成功
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

/// 存储 TTS API Key 到 OS Keychain。
pub fn store_tts_key(key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")
        .map_err(|e| AppError::Credential(format!("keyring entry error: {e}")))?;
    entry
        .set_password(key)
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))
}

/// 从 OS Keychain 读取 TTS API Key。
pub fn get_tts_key() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")
        .map_err(|e| format!("keyring entry error: {e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}
