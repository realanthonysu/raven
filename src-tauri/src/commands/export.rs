//! 导出与备份 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_export_words_csv` - 导出全部生词为 CSV 格式
//! - `db_export_words_anki` - 导出全部生词为 Anki 导入格式（TSV）
//! - `db_backup_db` - 备份数据库文件到指定路径
//! - `db_restore_db` - 从备份文件恢复数据库（破坏性，覆盖当前数据）
//! - `write_text_file` - 将文本内容写入指定文件（含系统路径防护）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::export;

use super::shared::with_db_read;

/// Export all vocabulary as CSV.
#[tauri::command]
pub async fn db_export_words_csv(db: State<'_, Db>) -> Result<String, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| export::export_words_csv(
        conn
    ))
}

/// Export all vocabulary in Anki import format (tab-separated).
#[tauri::command]
pub async fn db_export_words_anki(db: State<'_, Db>) -> Result<String, AppError> {
    with_db_read!(db, |conn: &rusqlite::Connection| export::export_words_anki(
        conn
    ))
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
        export::backup_db(&conn, &dest_path)
    })
    .await
    .map_err(|e| AppError::Database(format!("backup task panicked: {e}")))?
}

/// Restore database from a backup file (destructive — replaces current data).
///
/// Frontend must confirm with the user before calling. Source path goes through
/// the same user-directory whitelist as backup; restore writes through SQLite
/// Backup into the live connection (pool stays valid).
#[tauri::command]
pub async fn db_restore_db(db: State<'_, Db>, source_path: String) -> Result<(), AppError> {
    // 与 backup 相同的白名单：仅允许从用户级目录读取备份
    let src = validate_write_path(&source_path)?;
    let source_path = src.to_string_lossy().into_owned();
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        export::restore_db(&mut conn, &source_path)
    })
    .await
    .map_err(|e| AppError::Database(format!("restore task panicked: {e}")))?
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
        if let Ok(canon_raven) = std::fs::canonicalize(&raven_dir)
            && let Ok(canon_home) = std::fs::canonicalize(&home)
            && canon_raven.starts_with(&canon_home)
        {
            allowed_dirs.push(raven_dir);
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

    // 末段符号链接防护：上面只 canonicalize 了父目录，dest 自身若是符号链接，
    // 写入（write_text_file / backup）会跟随链接跳到白名单之外的目标上，
    // 读取（restore 的 source）同样会读到白名单外的文件——白名单被绕过。
    // dest 不存在是正常的覆盖写场景（首次导出/备份），不能因此报错，故只在
    // symlink_metadata 成功且确为符号链接时拒绝。
    // 注：Windows 目录 junction（挂载点重解析点）在 stable std 下无法与
    // OneDrive 占位文件等其他重解析点区分，一律按符号链接拒绝会误伤
    // OneDrive 同步目录，故只拦 is_symlink。
    if let Ok(meta) = std::fs::symlink_metadata(dest)
        && meta.file_type().is_symlink()
    {
        tracing::warn!(
            path = %path,
            "export path refused: final path segment is a symlink"
        );
        return Err(AppError::Export(format!(
            "refused: target path '{path}' is a symlink"
        )));
    }

    Ok(dest.to_path_buf())
}

/// Write text content to a file at the specified path.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), AppError> {
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

    #[test]
    fn validate_write_path_rejects_symlinked_final_segment() {
        // 末段符号链接越权场景：链接放在白名单目录内、指向白名单外。
        // 需要一个真实的白名单目录（dirs::document_dir 在无用户目录的
        // 环境下返回 None，如某些 CI 容器）——取不到就跳过。
        let Some(base) = dirs::document_dir() else {
            eprintln!("skip: no document directory on this machine");
            return;
        };
        // 探测目录挂在白名单内；链接目标放在白名单外（系统临时目录）
        let probe = base.join("raven_export_symlink_test");
        std::fs::create_dir_all(&probe).unwrap();
        let outside = std::env::temp_dir().join("raven_export_symlink_target.db");
        let link = probe.join("linked.db");

        // Windows 创建符号链接可能需要开发者模式/管理员特权；拿不到特权时
        // 跳过而非失败（未开 Developer Mode 的机器上不应因此红灯）。
        // ERROR_PRIVILEGE_NOT_HELD(1314) 在 Rust 中未映射为 PermissionDenied，
        // 需按原始 OS 错误码单独识别。
        #[cfg(windows)]
        let link_created = match std::os::windows::fs::symlink_file(&outside, &link) {
            Ok(()) => true,
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(1314) =>
            {
                eprintln!(
                    "skip: symlink creation requires Developer Mode or admin on Windows: {e}"
                );
                false
            }
            Err(e) => panic!("failed to create test symlink: {e}"),
        };
        #[cfg(not(windows))]
        let link_created = match std::os::unix::fs::symlink(&outside, &link) {
            Ok(()) => true,
            Err(e) => panic!("failed to create test symlink: {e}"),
        };

        if link_created {
            // 末段是符号链接 → 拒绝
            let result = validate_write_path(link.to_str().unwrap());
            assert!(result.is_err(), "末段为符号链接的路径应被拒绝");
            let msg = result.unwrap_err().to_string();
            assert!(
                msg.contains("symlink"),
                "错误信息应说明是符号链接，got: {msg}"
            );

            // 对照组：同目录下的普通（不存在）路径应放行——覆盖写场景不能误伤
            let normal = probe.join("normal.db");
            assert!(
                validate_write_path(normal.to_str().unwrap()).is_ok(),
                "普通路径应通过校验"
            );
        }

        // 清理测试残留（先链接后目录）
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir(&probe);
    }
}
