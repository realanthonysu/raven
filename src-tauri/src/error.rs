/// Structured error types for all Tauri command handlers.
///
/// Each variant represents a distinct failure category, enabling the frontend
/// (and logging) to distinguish between error origins. The `Serialize` derive
/// satisfies Tauri's IPC requirement — errors are transmitted as strings over
/// the invoke boundary (Tauri calls `.to_string()` on the error).
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
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

// -- Automatic conversions from common error types --

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}
