//! 导出与备份 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `export_words_csv` - 导出全部生词为 CSV 格式
//! - `export_words_anki` - 导出全部生词为 Anki 导入格式（TSV）
//! - `backup_db` - 备份数据库文件到指定路径
//! - `write_text_file` - 将文本内容写入指定文件（含系统路径防护）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::with_db;

/// Export all vocabulary as CSV.
#[tauri::command]
pub async fn export_words_csv(db: State<'_, Db>) -> Result<String, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::export_words_csv(conn)
    })
}

/// Export all vocabulary in Anki import format (tab-separated).
#[tauri::command]
pub async fn export_words_anki(db: State<'_, Db>) -> Result<String, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::export_words_anki(conn)
    })
}

/// Backup the database file to the specified path.
///
/// P3-10: 使用 tokio::task::spawn_blocking 将 SQLite backup 操作移出 async 运行时线程，
/// 避免 IO 密集的备份流程阻塞其它 Command 的调度。
#[tauri::command]
pub async fn backup_db(db: State<'_, Db>, dest_path: String) -> Result<(), AppError> {
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("pool error: {e}")))?;
        repository::backup_db(&conn, &dest_path)
    })
    .await
    .map_err(|e| AppError::Export(format!("backup task join error: {e}")))?
}

/// Write text content to a file at the specified path.
///
/// P3-2: 校验目标路径不在系统关键目录中，防止 XSS 后恶意调用覆盖系统文件。
/// 前端调用方已通过 dialog save() 让用户显式选择路径，此处为兜底防御。
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), AppError> {
    let dest = std::path::Path::new(&path);
    // 校验路径非系统敏感目录（Windows / Linux / macOS）
    // 将正斜杠统一为反斜杠后再匹配，防止 Windows 下 c:/windows/ 绕过 c:\windows\ 黑名单
    let path_str = path.to_lowercase().replace('/', "\\");
    let is_system_path = [
        "c:\\windows\\",
        "c:\\program files",
        "c:\\programdata",
        "\\etc\\",
        "\\usr\\",
        "\\bin\\",
        "\\sbin\\",
        "\\system\\",
        "\\library\\system\\",
    ]
    .iter()
    .any(|p| path_str.starts_with(p) || path_str.contains(p));
    if is_system_path {
        tracing::warn!(path = %path, "write_text_file refused: path in system directory");
        return Err(AppError::Export(
            "refused: path in system directory".to_string(),
        ));
    }
    tokio::fs::write(dest, &content)
        .await
        .map_err(|e| AppError::Export(format!("Failed to write file {path}: {e}")))
}
