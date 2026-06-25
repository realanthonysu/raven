/// Structured error types for all Tauri command handlers.
///
/// Each variant represents a distinct failure category, enabling the frontend
/// (and logging) to distinguish between error origins. The custom `Serialize`
/// impl serializes as a plain string (via `Display`), maintaining backward
/// compatibility with the frontend which expects `invoke()` rejections to be
/// strings.
use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    /// SQLite / rusqlite errors, Mutex poisoning.
    #[error("Database error: {0}")]
    Database(String),

    /// OS Keychain / credential storage errors.
    #[error("Credential error: {0}")]
    Credential(String),

    /// CSV export, Anki export, or database backup failures.
    #[error("Export error: {0}")]
    Export(String),

    /// Filesystem / IO errors.
    #[error("IO error: {0}")]
    Io(String),
}

/// Serialize as a structured object so the frontend can distinguish error categories.
/// The object has two fields: `category` (the enum variant name) and `message` (the display text).
/// This preserves backward compatibility because the message text is still available,
/// while enabling callers to branch on the category for differentiated handling.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let category = match self {
            AppError::Database(_) => "database",
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

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(e: csv::Error) -> Self {
        AppError::Export(e.to_string())
    }
}

impl From<std::string::FromUtf8Error> for AppError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        AppError::Export(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Credential(e.to_string())
    }
}

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
        assert!(
            matches!(app_err, AppError::Credential(ref m) if m.contains("keyring")),
            "expected Credential variant mentioning keyring, got: {app_err:?}"
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
