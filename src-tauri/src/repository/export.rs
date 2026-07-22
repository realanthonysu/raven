//! CSV/Anki 导出与数据库备份。

use crate::error::AppError;

/// 净化 CSV 单元格：若字段以公式触发字符（= + - @）开头，前缀单引号防止 Excel/LibreOffice
/// 将其解释为公式执行（CSV Injection 防御）。
fn sanitize_csv_cell(s: &str) -> String {
    if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

/// Export all vocabulary as CSV.
pub fn export_words_csv(conn: &rusqlite::Connection) -> Result<String, AppError> {
    let mut stmt = conn.prepare(
        "SELECT word, phonetic, definition, level, source_type, notes, review_status, review_count, next_review_at, created_at FROM words ORDER BY created_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>("word")?,
            row.get::<_, Option<String>>("phonetic")?,
            row.get::<_, String>("definition")?,
            row.get::<_, Option<String>>("level")?,
            row.get::<_, Option<String>>("source_type")?,
            row.get::<_, Option<String>>("notes")?,
            row.get::<_, String>("review_status")?,
            row.get::<_, Option<i64>>("review_count")?,
            row.get::<_, Option<String>>("next_review_at")?,
            row.get::<_, String>("created_at")?,
        ))
    })?;

    let mut wtr = csv::Writer::from_writer(Vec::new());
    wtr.write_record([
        "word",
        "phonetic",
        "definition",
        "level",
        "source_type",
        "notes",
        "review_status",
        "review_count",
        "next_review_at",
        "created_at",
    ])
    .map_err(|e| AppError::Export(format!("CSV header error: {e}")))?;

    for row_result in rows {
        let (word, phonetic, definition, level, source_type, notes, status, count, nra, created) =
            row_result?;
        // 对用户可控字段进行 CSV 公式注入净化
        wtr.write_record(&[
            sanitize_csv_cell(&word),
            sanitize_csv_cell(&phonetic.unwrap_or_default()),
            sanitize_csv_cell(&definition),
            sanitize_csv_cell(&level.unwrap_or_default()),
            sanitize_csv_cell(&source_type.unwrap_or_default()),
            sanitize_csv_cell(&notes.unwrap_or_default()),
            sanitize_csv_cell(&status),
            count.unwrap_or(0).to_string(),
            sanitize_csv_cell(&nra.unwrap_or_default()),
            sanitize_csv_cell(&created),
        ])
        .map_err(|e| AppError::Export(format!("CSV write error: {e}")))?;
    }

    let bytes = wtr
        .into_inner()
        .map_err(|e| AppError::Export(format!("CSV flush error: {e}")))?;
    String::from_utf8(bytes).map_err(|e| AppError::Export(format!("CSV encoding error: {e}")))
}

/// Export all vocabulary in Anki import format (tab-separated).
pub fn export_words_anki(conn: &rusqlite::Connection) -> Result<String, AppError> {
    let mut stmt = conn
        .prepare("SELECT word, phonetic, definition, notes FROM words ORDER BY created_at DESC")?;

    let mut output = String::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>("word")?,
            row.get::<_, Option<String>>("phonetic")?,
            row.get::<_, String>("definition")?,
            row.get::<_, Option<String>>("notes")?,
        ))
    })?;

    for (word, phonetic, definition, notes) in rows.collect::<Result<Vec<_>, _>>()? {
        let phonetic_str = phonetic.as_deref().unwrap_or("");
        let notes_str = notes.as_deref().unwrap_or("");
        // 净化：转义 Tab/换行符防止字段错位，转义 HTML 特殊字符防止 Anki 卡片渲染异常
        let safe_word = sanitize_anki_cell(&word);
        let safe_phonetic = sanitize_anki_cell(phonetic_str);
        let safe_definition = sanitize_anki_cell(&definition);
        let safe_notes = sanitize_anki_cell(notes_str);
        output.push_str(&format!(
            "{}\t{} <br> {} <br> {}\n",
            safe_word, safe_phonetic, safe_definition, safe_notes
        ));
    }
    Ok(output)
}

/// 净化 Anki 导出单元格：将 Tab/换行符替换为空格防止字段错位，
/// 转义 HTML 特殊字符（& < >）防止 Anki 卡片渲染异常或 XSS。
/// 提取为模块级函数以便单元测试（B-14 修复）。
fn sanitize_anki_cell(s: &str) -> String {
    s.replace(['\t', '\r', '\n'], " ")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Backup the database file to the specified path.
pub fn backup_db(conn: &rusqlite::Connection, dest_path: &str) -> Result<(), AppError> {
    // 原子创建目标文件以防止 TOCTOU 竞态：create_new 在文件已存在时返回 AlreadyExists，
    // 消除了 exists() 检查与文件创建之间的时间窗口。
    let dest = std::path::Path::new(dest_path);
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dest)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Export(format!("Backup destination already exists: {dest_path}"))
            } else {
                AppError::Database(format!("Failed to create backup destination: {e}"))
            }
        })?;
    // WAL checkpoint 确保所有已提交事务写入主数据库文件
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| AppError::Database(format!("WAL checkpoint failed: {e}")))?;
    let mut dest = rusqlite::Connection::open(dest_path)
        .map_err(|e| AppError::Database(format!("Failed to open backup destination: {e}")))?;
    let backup = rusqlite::backup::Backup::new(conn, &mut dest)
        .map_err(|e| AppError::Database(format!("Backup init failed: {e}")))?;
    backup
        .run_to_completion(100, std::time::Duration::from_millis(10), None)
        .map_err(|e| AppError::Database(format!("Backup failed: {e}")))?;
    Ok(())
}

// ============================================================================
// Unit tests — 覆盖净化函数（不依赖 DB / Keychain）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_csv_cell (B-13: CSV 公式注入防御) ──

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_equals_prefix() {
        assert_eq!(
            sanitize_csv_cell("=CMD|' /C calc'!A1"),
            "'=CMD|' /C calc'!A1"
        );
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_plus_prefix() {
        assert_eq!(sanitize_csv_cell("+1+1"), "'+1+1");
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_minus_prefix() {
        assert_eq!(sanitize_csv_cell("-1+1"), "'-1+1");
    }

    #[test]
    fn sanitize_csv_cell_prepends_quote_for_at_prefix() {
        assert_eq!(sanitize_csv_cell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
    }

    #[test]
    fn sanitize_csv_cell_leaves_safe_text_unchanged() {
        assert_eq!(sanitize_csv_cell("hello"), "hello");
        assert_eq!(sanitize_csv_cell("definition text"), "definition text");
        assert_eq!(sanitize_csv_cell(""), "");
        assert_eq!(sanitize_csv_cell("42"), "42");
        assert_eq!(sanitize_csv_cell("_internal"), "_internal");
    }

    #[test]
    fn sanitize_csv_cell_does_not_touch_formula_in_middle() {
        assert_eq!(sanitize_csv_cell("a=b"), "a=b");
        assert_eq!(sanitize_csv_cell("text = value"), "text = value");
    }

    // ── sanitize_anki_cell (B-14: HTML 转义 + 字段错位防御) ──

    #[test]
    fn sanitize_anki_cell_escapes_ampersand() {
        assert_eq!(sanitize_anki_cell("Tom & Jerry"), "Tom &amp; Jerry");
    }

    #[test]
    fn sanitize_anki_cell_escapes_angle_brackets() {
        assert_eq!(sanitize_anki_cell("<script>"), "&lt;script&gt;");
        assert_eq!(sanitize_anki_cell("a<b>c"), "a&lt;b&gt;c");
    }

    #[test]
    fn sanitize_anki_cell_replaces_tab_with_space() {
        assert_eq!(sanitize_anki_cell("a\tb"), "a b");
        assert_eq!(sanitize_anki_cell("a\t\tb"), "a  b");
    }

    #[test]
    fn sanitize_anki_cell_replaces_newlines_with_space() {
        assert_eq!(sanitize_anki_cell("line1\nline2"), "line1 line2");
        assert_eq!(sanitize_anki_cell("line1\r\nline2"), "line1  line2");
    }

    #[test]
    fn sanitize_anki_cell_combined_injection_attempt() {
        let input = "<img\tonerror=alert(1)\nsrc=x>";
        let out = sanitize_anki_cell(input);
        assert!(out.contains("&lt;img"));
        assert!(out.contains("&gt;"));
        assert!(!out.contains('\t'));
        assert!(!out.contains('\n'));
    }

    #[test]
    fn sanitize_anki_cell_preserves_safe_text() {
        assert_eq!(sanitize_anki_cell("hello world"), "hello world");
        assert_eq!(sanitize_anki_cell(""), "");
        assert_eq!(sanitize_anki_cell("it's \"fine\""), "it's \"fine\"");
    }

    #[test]
    fn sanitize_anki_cell_escapes_ampersand_before_brackets() {
        let out = sanitize_anki_cell("&<>");
        assert_eq!(out, "&amp;&lt;&gt;");
    }
}
