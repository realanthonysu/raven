//! 导出与备份 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_export_words_csv` - 导出全部生词为 CSV 格式
//! - `db_export_words_anki` - 导出全部生词为 Anki 导入格式（TSV）
//! - `db_backup_db` - 备份数据库文件到指定路径（内部/兼容用途，白名单内路径）
//! - `db_backup_db_dialog` - 原生保存对话框 + 直接写入（用户任选位置）
//! - `db_backup_db_default` - 不弹对话框，写入 Documents/Raven 默认位置（恢复前自动快照）
//! - `db_restore_db` - 从备份文件恢复数据库（破坏性，覆盖当前数据）
//! - `write_text_file` - 将文本内容写入白名单内的指定路径
//! - `write_text_file_dialog` - 原生保存对话框 + 写入文本内容（用户任选位置）

use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

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

/// Backup the database via a native save dialog owned by the trusted process.
///
/// A1: 旧流程由 WebView 弹 `save()` 再把路径传回来过写路径白名单——用户选
/// D 盘/移动盘/网络共享必然失败。改为受信任进程直接弹窗并写入：路径根本不
/// 经过 WebView，白名单只保护"前端任意指定路径"的场景，不限制用户显式选择
/// 的文件。用户取消返回 `Ok(None)`。
///
/// 弹窗与备份都在 `spawn_blocking` 中执行：`blocking_save_file` 阻塞当前线程
/// 等待用户操作（内部经 `run_on_main_thread` 在主线程弹窗），不能占用 Tokio
/// worker，也不能在主线程调用（会与事件循环死锁）。
#[tauri::command]
pub async fn db_backup_db_dialog(
    app: AppHandle,
    db: State<'_, Db>,
    default_file_name: String,
) -> Result<Option<String>, AppError> {
    let pool = db.0.clone();
    let written = tokio::task::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name(default_file_name)
            .add_filter("SQLite Database", &["db"])
            .blocking_save_file();
        let Some(file) = picked else {
            return Ok::<Option<String>, AppError>(None); // 用户取消对话框
        };
        let dest = file.into_path().map_err(|e| {
            AppError::Export(format!("backup dialog returned an unusable path: {e}"))
        })?;
        let dest_path = dest.to_string_lossy().into_owned();
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        export::backup_db(&conn, &dest_path)?;
        Ok(Some(dest_path))
    })
    .await
    .map_err(|e| AppError::Export(format!("backup dialog task panicked: {e}")))??;
    Ok(written)
}

/// Backup the database to the default location without any dialog:
/// `<Documents>/Raven/<file_name>`，falling back to `<home>/Raven` when
/// Documents is unavailable/unwritable.
///
/// A1: 供恢复前自动快照使用——快照必须落在受控目录，不能跟随用户早先选择的
/// 任意备份位置（用户可能把原备份放在可移动介质上，恢复中拔出即快照丢失）。
#[tauri::command]
pub async fn db_backup_db_default(
    db: State<'_, Db>,
    default_file_name: String,
) -> Result<String, AppError> {
    let dest = resolve_default_backup_path(&default_file_name)?;
    let dest_path = dest.to_string_lossy().into_owned();
    let dest_for_task = dest_path.clone();
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        export::backup_db(&conn, &dest_for_task)
    })
    .await
    .map_err(|e| AppError::Database(format!("backup task panicked: {e}")))??;
    Ok(dest_path)
}

/// Write text content to a file chosen through a native save dialog.
///
/// A1: 与 `db_backup_db_dialog` 同一策略——导出位置由用户在系统对话框里任选
/// （词汇导出目标是 U 盘/网络共享等白名单外路径是常见需求），不再经过
/// `validate_write_path`。用户取消返回 `Ok(None)`。
#[tauri::command]
pub async fn write_text_file_dialog(
    app: AppHandle,
    default_file_name: String,
    extension: String,
    content: String,
) -> Result<Option<String>, AppError> {
    let written = tokio::task::spawn_blocking(move || {
        let ext = extension.trim().trim_start_matches('.');
        let mut builder = app.dialog().file().set_file_name(default_file_name);
        if !ext.is_empty() {
            builder = builder.add_filter("File", &[ext]);
        }
        let Some(file) = builder.blocking_save_file() else {
            return Ok::<Option<String>, AppError>(None); // 用户取消对话框
        };
        let dest = file.into_path().map_err(|e| {
            AppError::Export(format!("export dialog returned an unusable path: {e}"))
        })?;
        let dest_path = dest.to_string_lossy().into_owned();
        std::fs::write(&dest, &content)
            .map_err(|e| AppError::Export(format!("Failed to write file {dest_path}: {e}")))?;
        Ok(Some(dest_path))
    })
    .await
    .map_err(|e| AppError::Export(format!("export dialog task panicked: {e}")))??;
    Ok(written)
}

/// Restore database from a backup file (destructive — replaces current data).
///
/// Frontend must confirm with the user before calling. Source path goes through
/// read-path validation: any existing file is accepted (restore only opens the
/// source read-only via SQLite Backup, so there is no "write anywhere" hole and
/// the write whitelist must not confine users to Documents/Desktop/Downloads —
/// backups on other drives / removable media / network shares have to be
/// restorable).
#[tauri::command]
pub async fn db_restore_db(db: State<'_, Db>, source_path: String) -> Result<(), AppError> {
    let src = validate_read_path(&source_path)?;
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

/// 解析默认备份目录（dirs 解析结果由参数注入，便于单测不碰真实用户目录）：
/// 优先 `<document_dir>/Raven`，创建失败（只读媒体、权限不足等）时回退
/// `<home_dir>/Raven`；两者皆不可用才报错。
fn resolve_default_backup_dir(
    document_dir: Option<&std::path::Path>,
    home_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, AppError> {
    if let Some(doc) = document_dir {
        let dir = doc.join("Raven");
        if std::fs::create_dir_all(&dir).is_ok() {
            return Ok(dir);
        }
    }
    if let Some(home) = home_dir {
        let dir = home.join("Raven");
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Export(format!("无法创建默认备份目录 {}: {e}", dir.display()))
        })?;
        return Ok(dir);
    }
    Err(AppError::Export(
        "无法解析默认备份目录（document/home 目录均不可用）".to_string(),
    ))
}

/// 默认备份文件全路径：目录解析 + 文件名单段校验。分隔符/`..` 会让快照落到
/// Raven/ 之外（默认位置的意义即"受控目录"），按非法输入拒绝。
fn resolve_default_backup_path(file_name: &str) -> Result<std::path::PathBuf, AppError> {
    let parsed = std::path::Path::new(file_name);
    if file_name.is_empty() || parsed.file_name() != Some(std::ffi::OsStr::new(file_name)) {
        return Err(AppError::Validation(format!(
            "备份文件名不合法: {file_name}"
        )));
    }
    let dir =
        resolve_default_backup_dir(dirs::document_dir().as_deref(), dirs::home_dir().as_deref())?;
    Ok(dir.join(file_name))
}

/// 校验恢复操作的**读**路径：允许任意已存在的文件（canonicalize 后 `is_file()`），
/// 拒绝目录与不存在的路径。
///
/// A1: 恢复只读打开源库（`SQLITE_OPEN_READ_ONLY`，见 `export::restore_db`），
/// 不存在"写入任意路径"的口子，故不再套用写白名单——否则用户只能从
/// Documents/Desktop/Downloads 恢复，放其他盘/移动介质/网络共享上的备份形同虚设。
/// canonicalize 顺带解析符号链接：链接目标不存在时报错，目标存在则按目标判定。
pub fn validate_read_path(path: &str) -> Result<std::path::PathBuf, AppError> {
    let canon = std::fs::canonicalize(path)
        .map_err(|e| AppError::Validation(format!("备份文件不存在或无法解析: {path} ({e})")))?;
    if !canon.is_file() {
        return Err(AppError::Validation(format!("备份路径不是文件: {path}")));
    }
    Ok(canon)
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

    // ── A1: 读路径校验（恢复源不再套用写白名单）──

    #[test]
    fn validate_read_path_accepts_existing_file_outside_write_whitelist() {
        // 系统临时目录不在写白名单（Documents/Desktop/Downloads）内——
        // 旧恢复流程会拒绝它，A1 起恢复必须能读任意位置的备份
        let file = std::env::temp_dir().join("raven_test_read_path.db");
        std::fs::write(&file, b"placeholder").unwrap();
        let result = validate_read_path(file.to_str().unwrap());
        assert!(
            result.is_ok(),
            "白名单外已存在的文件应通过读路径校验: {result:?}"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn validate_read_path_rejects_directory_and_missing_paths() {
        let dir = std::env::temp_dir().join("raven_test_read_path_dir");
        std::fs::create_dir_all(&dir).unwrap();

        assert!(
            validate_read_path(dir.to_str().unwrap()).is_err(),
            "目录路径应被拒绝"
        );
        assert!(
            validate_read_path(dir.join("missing.db").to_str().unwrap()).is_err(),
            "不存在的路径应被拒绝"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_restore_round_trip_works_outside_write_whitelist() {
        // A1 行为闭环：备份写到白名单外目录 → 读路径校验放行 → 恢复进新库。
        // 不走命令层（需要 Tauri State），直接驱动同一条 repository 路径。
        let conn = crate::db::create_test_db();
        let dest =
            std::env::temp_dir().join(format!("raven_test_round_trip_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dest);

        export::backup_db(&conn, dest.to_str().unwrap()).expect("backup to temp dir");
        assert!(dest.is_file(), "备份文件应已落盘");

        let validated = validate_read_path(dest.to_str().unwrap()).expect("读路径校验放行");
        let mut target = crate::db::create_test_db();
        export::restore_db(&mut target, validated.to_str().unwrap())
            .expect("restore from whitelisted-outside file");

        let _ = std::fs::remove_file(&dest);
    }

    // ── A1: 默认备份目录解析（纯函数，不碰真实用户目录）──

    #[test]
    fn resolve_default_backup_dir_prefers_documents_and_creates_raven_subdir() {
        let base = std::env::temp_dir().join("raven_test_backup_documents");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let dir = resolve_default_backup_dir(Some(&base), None).unwrap();
        assert_eq!(dir, base.join("Raven"));
        assert!(dir.is_dir(), "Raven 子目录应被创建");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_default_backup_dir_falls_back_to_home_when_documents_unwritable() {
        let base = std::env::temp_dir().join("raven_test_backup_fallback");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // document_dir 指向一个已存在的文件 → 其下创建 Raven/ 必然失败，触发回退
        let blocker = base.join("doc_file");
        std::fs::write(&blocker, b"x").unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();

        let dir = resolve_default_backup_dir(Some(&blocker), Some(&home)).unwrap();
        assert_eq!(dir, home.join("Raven"));
        assert!(dir.is_dir(), "回退目录应被创建");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_default_backup_dir_errors_when_no_directory_available() {
        let err = resolve_default_backup_dir(None, None).unwrap_err();
        assert!(
            matches!(err, AppError::Export(_)),
            "两个目录都取不到时应报 Export 错: {err:?}"
        );
    }

    #[test]
    fn resolve_default_backup_path_rejects_non_single_segment_names() {
        // 单段校验：分隔符/.. 会让快照落到 Raven/ 之外
        let mut bad: Vec<&str> = vec!["", "..", "../evil.db", "sub/dir.db"];
        #[cfg(windows)]
        bad.push("a\\b.db");
        for name in bad {
            assert!(
                matches!(
                    resolve_default_backup_path(name),
                    Err(AppError::Validation(_))
                ),
                "{name} 应被 Validation 拒绝"
            );
        }
        // 合法名单：只断言不走校验失败（CI 容器可能连 home 都没有，
        // 此时是目录解析报 Export 错，同样属于"未被当作非法文件名"）
        assert!(
            !matches!(
                resolve_default_backup_path("raven-snapshot.db"),
                Err(AppError::Validation(_))
            ),
            "普通文件名不应被文件名校验拒绝"
        );
    }
}
