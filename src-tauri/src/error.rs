//! 应用统一错误类型。
//!
//! 定义 [`AppError`] 枚举，涵盖数据库、凭据存储、导出和 IO 四类错误。
//! 所有 Tauri Command handler 的返回类型均使用 `Result<T, AppError>`，
//! 通过自定义 `Serialize` 实现将错误序列化为 `{ category, message }` 结构体，
//! 便于前端按 `category` 字段进行差异化错误处理。

/// 所有 Tauri command handler 的结构化错误类型。
///
/// 每个变体代表一种独立的错误类别，使前端（和日志）能够区分错误来源。
/// 自定义 `Serialize` 实现将其序列化为结构化对象 `{ category, message }`，
/// 其中 `category` 为变体名（如 `"database"`），`message` 为 `Display` 文本。
/// 前端调用方应读取 `err.message`（或检查 `err.category` 进行差异化处理），
/// 而非期望得到纯字符串。
use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    /// SQLite / rusqlite 错误、Mutex 中毒。
    #[error("Database error: {0}")]
    Database(String),

    /// 调用方输入校验失败（非法枚举值、超长字段、格式错误等）。
    /// 与 Database 区分：前端可按 category 提示用户修正输入，而非报告数据库故障。
    #[error("Validation error: {0}")]
    Validation(String),

    /// 操作系统 Keychain / 凭据存储错误。
    #[error("Credential error: {0}")]
    Credential(String),

    /// CSV 导出、Anki 导出或数据库备份失败。
    #[error("Export error: {0}")]
    Export(String),

    /// 文件系统 / IO 错误。
    #[error("IO error: {0}")]
    Io(String),
}

/// 序列化为结构化对象，使前端能区分错误类别。
/// 对象包含两个字段：`category`（枚举变体名）和 `message`（Display 文本）。
/// 保持向后兼容——消息文本仍然可用，同时允许调用方按 category 分支处理。
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let category = match self {
            AppError::Database(_) => "database",
            AppError::Validation(_) => "validation",
            AppError::Credential(_) => "credential",
            AppError::Export(_) => "export",
            AppError::Io(_) => "io",
        };
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("category", category)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// -- Automatic conversions from common error types --

/// 将 rusqlite 数据库错误转换为 `AppError::Database`。
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

/// 将 CSV 序列化错误转换为 `AppError::Export`。
impl From<csv::Error> for AppError {
    fn from(e: csv::Error) -> Self {
        AppError::Export(e.to_string())
    }
}

/// 将 UTF-8 解码错误转换为 `AppError::Export`。
impl From<std::string::FromUtf8Error> for AppError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        AppError::Export(e.to_string())
    }
}

/// 将 OS Keychain 操作错误转换为 `AppError::Credential`。
impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Credential(e.to_string())
    }
}

/// 将标准 IO 错误转换为 `AppError::Io`。
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

// ============================================================================
// Unit tests — 覆盖错误类型转换 + 序列化格式
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── B-15: From<std::io::Error> 转换 ──

    #[test]
    fn from_io_error_maps_to_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let app_err = AppError::from(io_err);
        assert!(
            matches!(app_err, AppError::Io(ref m) if m.contains("file missing")),
            "expected Io variant with 'file missing' message, got: {app_err:?}"
        );
    }

    #[test]
    fn from_io_error_preserves_message_for_other_kinds() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(ref m) if m.contains("denied")));
    }

    // ── From<rusqlite::Error> 转换 ──

    #[test]
    fn from_rusqlite_error_maps_to_database_variant() {
        // SQLite Error::SqliteFailure 是常见的底层错误
        let sqlite_err = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some("no such table: words".to_string()),
        );
        let app_err = AppError::from(sqlite_err);
        assert!(matches!(app_err, AppError::Database(_)));
    }

    // ── From<keyring::Error> 转换 ──

    #[test]
    fn from_keyring_error_maps_to_credential_variant() {
        let kr_err = keyring::Error::NoEntry;
        let app_err = AppError::from(kr_err);
        // 仅校验 variant 匹配，不依赖 keyring crate 的 Display 文本
        // (不同后端/版本可能显示 "keychain" / "secure storage" 等不同措辞)
        assert!(
            matches!(app_err, AppError::Credential(_)),
            "expected Credential variant, got: {app_err:?}"
        );
    }

    // ── Display 输出 ──

    #[test]
    fn display_includes_variant_prefix_and_message() {
        let db_err = AppError::Database("connection lost".to_string());
        assert_eq!(db_err.to_string(), "Database error: connection lost");

        let cred_err = AppError::Credential("denied".to_string());
        assert_eq!(cred_err.to_string(), "Credential error: denied");

        let export_err = AppError::Export("CSV failed".to_string());
        assert_eq!(export_err.to_string(), "Export error: CSV failed");

        let io_err = AppError::Io("EOF".to_string());
        assert_eq!(io_err.to_string(), "IO error: EOF");
    }

    // ── Serialize 输出结构（前端依赖 category 字段分支处理）──

    #[test]
    fn serialize_emits_category_and_message_fields() {
        // 序列化为 JSON value 并验证字段结构
        let db_err = AppError::Database("boom".to_string());
        let json = serde_json::to_value(&db_err).expect("serialize failed");
        let obj = json.as_object().expect("expected JSON object");
        assert_eq!(obj.len(), 2, "expected exactly 2 fields, got: {obj:?}");
        assert_eq!(
            obj.get("category").and_then(|v| v.as_str()),
            Some("database")
        );
        assert_eq!(
            obj.get("message").and_then(|v| v.as_str()),
            Some("Database error: boom")
        );
    }

    #[test]
    fn serialize_category_differs_per_variant() {
        let cases: &[(AppError, &str)] = &[
            (AppError::Database("x".into()), "database"),
            (AppError::Validation("x".into()), "validation"),
            (AppError::Credential("x".into()), "credential"),
            (AppError::Export("x".into()), "export"),
            (AppError::Io("x".into()), "io"),
        ];
        for (err, expected_category) in cases {
            let json = serde_json::to_value(err).expect("serialize failed");
            let actual = json
                .get("category")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>");
            assert_eq!(
                actual, *expected_category,
                "variant {err:?} should serialize category='{expected_category}'"
            );
        }
    }
}
