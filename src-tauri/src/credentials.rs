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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::error::AppError;

/// Keychain 服务名称，所有凭据均存储在此服务标识下。
const SERVICE_NAME: &str = "raven";

/// 进程内 Keychain 读缓存 TTL。写路径（store/delete）会立即失效对应条目，
/// TTL 仅兜底「应用外改动密钥」场景。Keychain（尤其 Linux Secret Service）
/// 单次读可达 10–100ms，而 LLM/TTS 热路径每次请求都会读密钥。
const KEY_CACHE_TTL: Duration = Duration::from_secs(300);

struct CachedKey {
    /// `None` 表示缓存了「无条目」，避免反复 miss 同一不存在的 key
    value: Option<String>,
    fetched_at: Instant,
}

fn key_cache() -> &'static Mutex<HashMap<String, CachedKey>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedKey>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn model_cache_key(model_id: i64) -> String {
    format!("model_{model_id}")
}

const TTS_CACHE_KEY: &str = "tts";

/// 命中且未过期时返回缓存值（`Some(None)` = 已知无条目）；miss 返回 `None`。
fn cache_lookup(cache_key: &str) -> Option<Option<String>> {
    let cache = key_cache().lock().ok()?;
    let entry = cache.get(cache_key)?;
    if entry.fetched_at.elapsed() > KEY_CACHE_TTL {
        return None;
    }
    Some(entry.value.clone())
}

fn cache_store(cache_key: &str, value: Option<String>) {
    if let Ok(mut cache) = key_cache().lock() {
        cache.insert(
            cache_key.to_string(),
            CachedKey {
                value,
                fetched_at: Instant::now(),
            },
        );
    }
}

/// 读路径回写：仅当缓存中现有条目的 `fetched_at` 不晚于 `started`（即本次
/// Keychain 读开始之后没有并发写/删回写）时才写入。防止「过期读」用旧值覆盖
/// 并发写的新缓存，造成最长 TTL 时长的错误鉴权/「未配置」误判。
fn cache_store_if_stale(cache_key: &str, value: Option<String>, started: Instant) {
    if let Ok(mut cache) = key_cache().lock() {
        if let Some(existing) = cache.get(cache_key)
            && existing.fetched_at > started
        {
            return;
        }
        cache.insert(
            cache_key.to_string(),
            CachedKey {
                value,
                fetched_at: Instant::now(),
            },
        );
    }
}

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
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))?;
    cache_store(&model_cache_key(model_id), Some(key.to_string()));
    Ok(())
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
    let cache_key = model_cache_key(model_id);
    if let Some(cached) = cache_lookup(&cache_key) {
        return Ok(cached);
    }
    let started = Instant::now();
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("model_{model_id}"))?;
    match entry.get_password() {
        Ok(key) => {
            cache_store_if_stale(&cache_key, Some(key.clone()), started);
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => {
            cache_store_if_stale(&cache_key, None, started);
            Ok(None)
        }
        Err(e) => Err(AppError::Credential(format!("keyring get error: {e}"))),
    }
}

/// 从 OS Keychain 读取 API Key，失败时降级为空字符串。
///
/// Keychain 读取失败不应阻塞模型配置的展示/使用（如 `get_default_model`
/// 预填 api_key 字段），因此统一在此记录日志并回退空值。
///
/// 与 [`get_key`]（返回 `Err`）的差异：调用方是"展示/回填"路径，此处若上抛
/// `AppError::Credential` 会让整个查询失败——用户仅因 Keychain 偶发不可用
/// （如 Linux 上 gnome-keyring 未解锁）就看不到模型列表，得不偿失；降级为
/// 空串后，前端以 api_key 为空呈现"未配置"状态，且写路径（store_key）仍会
/// 返回 Err，不会静默丢失数据。而鉴权/代理等强依赖密钥的路径应使用
/// [`get_key`] 并处理 Err，不得使用本函数掩盖真实故障。
///
/// # Arguments
///
/// * `model_id` - 模型配置 ID
pub fn get_key_or_empty(model_id: i64) -> String {
    match get_key(model_id) {
        Ok(Some(k)) => k,
        Ok(None) => String::new(),
        Err(e) => {
            // 降级原因必须可见：Keychain 故障被掩盖为"未配置"，日志是唯一线索
            tracing::warn!(error = %e, model_id, "keychain read failed, degrading to empty key");
            String::new()
        }
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
        Ok(()) => {
            cache_store(&model_cache_key(model_id), None);
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            cache_store(&model_cache_key(model_id), None);
            Ok(())
        } // 不存在也算成功
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
        .map_err(|e| AppError::Credential(format!("keyring set error: {e}")))?;
    cache_store(TTS_CACHE_KEY, Some(key.to_string()));
    Ok(())
}

/// 从 OS Keychain 读取 TTS API Key。
///
/// # Returns
///
/// - `Ok(Some(key))` - 找到并返回 TTS API Key
/// - `Ok(None)` - 未找到
/// - `Err(AppError::Credential)` - Keychain 操作失败
pub fn get_tts_key() -> Result<Option<String>, AppError> {
    if let Some(cached) = cache_lookup(TTS_CACHE_KEY) {
        return Ok(cached);
    }
    let started = Instant::now();
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")?;
    match entry.get_password() {
        Ok(key) => {
            cache_store_if_stale(TTS_CACHE_KEY, Some(key.clone()), started);
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => {
            cache_store_if_stale(TTS_CACHE_KEY, None, started);
            Ok(None)
        }
        Err(e) => Err(AppError::Credential(format!("keyring get error: {e}"))),
    }
}

/// 删除 OS Keychain 中的 TTS API Key。
///
/// 如果 Keychain 条目不存在（`NoEntry`），视为成功（幂等删除）。
pub fn delete_tts_key() -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE_NAME, "tts")?;
    match entry.delete_credential() {
        Ok(()) => {
            cache_store(TTS_CACHE_KEY, None);
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            cache_store(TTS_CACHE_KEY, None);
            Ok(())
        } // 不存在也算成功
        Err(e) => Err(AppError::Credential(format!("keyring delete error: {e}"))),
    }
}

// ============================================================================
// Unit tests — 读缓存回写的并发安全（不触 OS Keychain，仅操作进程内缓存）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_aged_entry(cache_key: &str, value: Option<&str>, age: Duration) {
        let mut cache = key_cache().lock().expect("cache lock poisoned");
        cache.insert(
            cache_key.to_string(),
            CachedKey {
                value: value.map(String::from),
                fetched_at: Instant::now() - age,
            },
        );
    }

    fn raw_cached_value(cache_key: &str) -> Option<Option<String>> {
        key_cache()
            .lock()
            .ok()?
            .get(cache_key)
            .map(|e| e.value.clone())
    }

    #[test]
    fn stale_read_overwrites_expired_entry() {
        let key = "test_stale_read_overwrites_expired";
        // 已过期的旧缓存（早于本次读 started），读方结果应正常回写
        insert_aged_entry(key, Some("old"), KEY_CACHE_TTL + Duration::from_secs(1));
        let started = Instant::now() - Duration::from_millis(10);
        cache_store_if_stale(key, Some("fresh".to_string()), started);
        assert_eq!(raw_cached_value(key), Some(Some("fresh".to_string())));
    }

    #[test]
    fn stale_read_does_not_overwrite_concurrent_write() {
        let key = "test_stale_read_does_not_overwrite_concurrent_write";
        let started = Instant::now() - Duration::from_millis(10);
        // 模拟并发写路径在 Keychain 读期间完成：立即回写新值（fetched_at > started）
        cache_store(key, Some("new".to_string()));
        // 慢速 Keychain 读带着旧值返回，不得覆盖新缓存
        cache_store_if_stale(key, Some("stale".to_string()), started);
        assert_eq!(raw_cached_value(key), Some(Some("new".to_string())));
    }

    #[test]
    fn stale_read_fills_absent_entry() {
        let key = "test_stale_read_fills_absent_entry";
        let started = Instant::now() - Duration::from_millis(10);
        cache_store_if_stale(key, None, started);
        // 缺失条目应被写入（含缓存 NoEntry 的 None）
        assert_eq!(raw_cached_value(key), Some(None));
    }

    #[test]
    fn expired_entry_is_a_lookup_miss() {
        let key = "test_expired_entry_is_a_lookup_miss";
        insert_aged_entry(key, Some("old"), KEY_CACHE_TTL + Duration::from_secs(1));
        // TTL 语义不变：过期条目视为 miss，走 Keychain 读
        assert_eq!(cache_lookup(key), None);
    }
}
