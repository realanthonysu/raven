//! 导出与备份 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_export_words_csv` - 导出全部生词为 CSV 格式
//! - `db_export_words_anki` - 导出全部生词为 Anki 导入格式（TSV）
//! - `db_backup_db` - 备份数据库文件到指定路径
//! - `db_write_text_file` - 将文本内容写入指定文件（含系统路径防护）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::traits::{ReadRepository, WriteRepository};

use super::shared::with_db_read;

/// Export all vocabulary as CSV.
#[tauri::command]
pub async fn db_export_words_csv(db: State<'_, Db>) -> Result<String, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn.export_words_csv())
}

/// Export all vocabulary in Anki import format (tab-separated).
#[tauri::command]
pub async fn db_export_words_anki(db: State<'_, Db>) -> Result<String, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| conn.export_words_anki())
}

/// Backup the database file to the specified path.
///
/// 使用 tokio::task::spawn_blocking 将 SQLite backup 操作移出 async 运行时线程，
/// 避免 IO 密集的备份流程阻塞其它 Command 的调度。
#[tauri::command]
pub async fn db_backup_db(db: State<'_, Db>, dest_path: String) -> Result<(), AppError> {
    validate_write_path(&dest_path)?;
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        conn.backup_db(&dest_path)
    })
    .await
    .map_err(|e| AppError::Database(format!("backup task panicked: {e}")))?
}

/// Validate that a write path is in an allowed user directory.
///
/// 安全防御：使用白名单策略，仅允许写入用户级目录（文档、桌面、下载等）。
/// 通过 `std::fs::canonicalize` 解析真实路径（处理符号链接、短文件名、UNC 路径），
/// 然后检查是否在允许的目录前缀下。黑名单方式（H-1 修复前）可被 UNC、短文件名、
/// 非 C 盘符、相对路径穿越等多种方式绕过。
pub fn validate_write_path(path: &str) -> Result<std::path::PathBuf, AppError> {
    let dest = std::path::Path::new(path);

    // 白名单：收集用户级允许写入的目录
    let mut allowed_dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(doc) = dirs::document_dir() {
        allowed_dirs.push(doc);
    }
    if let Some(desktop) = dirs::desktop_dir() {
        allowed_dirs.push(desktop);
    }
    if let Some(downloads) = dirs::download_dir() {
        allowed_dirs.push(downloads);
    }
    if let Some(home) = dirs::home_dir() {
        // 允许写入 ~/Raven 目录（如 ~/Raven/backup.db）
        // 但先验证 canonicalize 后仍在 home 下——防止 ~/Raven 是指向其他目录的符号链接
        let raven_dir = home.join("Raven");
        if let Ok(canon_raven) = std::fs::canonicalize(&raven_dir) {
            if let Ok(canon_home) = std::fs::canonicalize(&home) {
                if canon_raven.starts_with(&canon_home) {
                    allowed_dirs.push(raven_dir);
                }
            }
        }
    }

    if allowed_dirs.is_empty() {
        return Err(AppError::Export(
            "refused: no user directories available for writing".to_string(),
        ));
    }

    // canonicalize 父目录（而非完整路径）：处理符号链接、8.3 短文件名（PROGRA~1）、
    // UNC 路径（\\server\share）、/../ 穿越等。对完整路径做 canonicalize 会因为
    // 文件不存在而失败（首次创建导出文件时），因此改为 canonicalize 父目录。
    let parent = dest.parent().unwrap_or(dest);
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| {
        AppError::Export(format!(
            "refused: cannot resolve parent directory of '{path}': {e}"
        ))
    })?;

    // 检查 canonicalized 父目录是否以某个允许目录为前缀
    let is_allowed = allowed_dirs.iter().any(|dir| {
        // 也 canonicalize 允许目录本身，确保比较在同一规范化空间
        if let Ok(canon_dir) = std::fs::canonicalize(dir) {
            canon_parent.starts_with(&canon_dir)
        } else {
            false
        }
    });

    if !is_allowed {
        tracing::warn!(
            path = %path,
            canon_parent = %canon_parent.display(),
            "write_text_file refused: path not in allowed user directories"
        );
        return Err(AppError::Export(
            "refused: path is not in an allowed directory (Documents, Desktop, Downloads)"
                .to_string(),
        ));
    }

    Ok(dest.to_path_buf())
}

/// Write text content to a file at the specified path.
#[tauri::command]
pub async fn db_write_text_file(path: String, content: String) -> Result<(), AppError> {
    let dest = validate_write_path(&path)?;
    tokio::fs::write(dest, &content)
        .await
        .map_err(|e| AppError::Export(format!("Failed to write file {path}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_write_path_rejects_empty_user_dirs() {
        // This test validates the function exists and returns an error for paths
        // that cannot be resolved. The actual directory whitelist depends on the
        // runtime environment (dirs::* crate), so we test the error path.
        let result = validate_write_path("/nonexistent_root_dir_that_should_not_exist/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn validate_write_path_rejects_nonexistent_parent() {
        let result = validate_write_path("/totally/bogus/path/file.txt");
        assert!(result.is_err());
    }
}
