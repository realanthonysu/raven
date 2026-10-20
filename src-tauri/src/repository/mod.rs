//! 数据访问层（Repository）—— 将 SQL 查询与 Tauri Command handler 分离。
//!
//! 每个函数接收 `&rusqlite::Connection` 并返回 `Result<T, AppError>`。
//! Command handler 通过 `with_db!` 宏获取连接后委托给本模块的函数。
//!
//! ## 模块结构
//!
//! - **models**: 模型配置 CRUD（API Key 存储在 OS Keychain）
//! - **words**: 生词本 CRUD + 复习调度
//! - **history**: 学习历史记录
//! - **settings**: 键值对设置（含 TTS 配置）
//! - **learning**: 学习打卡与目标管理
//! - **export**: CSV/Anki 导出与数据库备份

// 子模块对 crate 内（commands 层）可见，SQL 仍收敛在本目录内
pub(crate) mod export;
pub(crate) mod history;
pub(crate) mod learning;
pub(crate) mod models;
pub(crate) mod settings;
pub(crate) mod words;

use crate::error::AppError;

/// 在 `BEGIN IMMEDIATE` 事务中执行闭包，统一 COMMIT/ROLLBACK 收尾。
///
/// - BEGIN IMMEDIATE 立即取写锁：并发写同一行时串行执行，后到事务读到先到事务
///   提交后的状态，消除 check-then-act 竞态与丢失更新
/// - 闭包返回 `Err` 时 ROLLBACK 并透传错误
/// - COMMIT 失败（磁盘满/SQLITE_BUSY 等）时连接仍处于事务状态，必须 ROLLBACK
///   归还干净连接，避免 r2d2 回收后下一个借用者继承脏事务
pub(crate) fn with_immediate_tx<T>(
    conn: &rusqlite::Connection,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = f(conn);
    match outcome {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(e) => {
                if let Err(rb) = conn.execute_batch("ROLLBACK") {
                    tracing::warn!(error = %rb, "failed to rollback after COMMIT failure");
                }
                Err(AppError::from(e))
            }
        },
        Err(e) => {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                tracing::warn!(error = %rb, "failed to rollback transaction");
            }
            Err(e)
        }
    }
}

// ============================================================================
// String enum validation (防止前端传入非法枚举值破坏查询语义)
// ============================================================================

/// 校验 review_status 参数。合法值: new / learning / mastered。
pub(crate) fn validate_review_status(status: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &["new", "learning", "mastered"];
    if VALID.contains(&status) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Invalid review_status: '{status}'. Expected one of: new, learning, mastered"
        )))
    }
}

/// 校验 record_type 参数。合法值: correct / writing / reading / listening / speaking / exercise。
pub(crate) fn validate_record_type(record_type: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &[
        "correct",
        "writing",
        "reading",
        "listening",
        "speaking",
        "exercise",
    ];
    if VALID.contains(&record_type) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Invalid record_type: '{record_type}'. Expected one of: correct, writing, reading, listening, speaking, exercise"
        )))
    }
}

/// 校验 goal_type 参数。合法值: review / exercise / reading / writing / listening / speaking。
pub(crate) fn validate_goal_type(goal_type: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &[
        "review",
        "exercise",
        "reading",
        "writing",
        "listening",
        "speaking",
    ];
    if VALID.contains(&goal_type) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Invalid goal_type: '{goal_type}'. Expected one of: review, exercise, reading, writing, listening, speaking"
        )))
    }
}

/// 校验 history.difficulty_level 参数（CEFR 级别码，级别体系写入路径白名单）。
/// `None` 合法（未标注级别）；`Some` 必须是 A2..C1 之一，空串同样拒绝
/// （与词汇等级不同：difficulty_level 没有"清空"语义，空串只会污染展示层）。
pub(crate) fn validate_difficulty_level(level: Option<&str>) -> Result<(), AppError> {
    const VALID: &[&str] = &["A2", "B1", "B1+", "B2", "B2+", "C1"];
    match level {
        None => Ok(()),
        Some(l) if VALID.contains(&l) => Ok(()),
        Some(l) => Err(AppError::Validation(format!(
            "Invalid difficulty_level: '{l}'. Expected one of: A2, B1, B1+, B2, B2+, C1"
        ))),
    }
}

/// 校验 words.level 参数（中国英语考试体系词汇等级，白名单与前端 WordLevelSchema 对齐）。
/// `None` 合法（未标注）；空串合法（update_word_level 的清空语义）；
/// 非空值必须是 11 个锚点之一。
pub(crate) fn validate_word_level(level: Option<&str>) -> Result<(), AppError> {
    const VALID: &[&str] = &[
        "小学", "中考", "高考", "CET-4", "CET-6", "考研", "TEM-4", "TEM-8", "雅思", "托福", "超纲",
    ];
    match level {
        None => Ok(()),
        Some("") => Ok(()),
        Some(l) if VALID.contains(&l) => Ok(()),
        Some(l) => Err(AppError::Validation(format!(
            "invalid word level: '{l}', expected one of: {VALID:?}"
        ))),
    }
}

// ============================================================================
// Unit tests — 覆盖验证辅助函数和净化函数
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_review_status (B-18: 校验枚举值防止 SQL 语义被破坏) ──

    #[test]
    fn validate_review_status_accepts_valid_values() {
        assert!(validate_review_status("new").is_ok());
        assert!(validate_review_status("learning").is_ok());
        assert!(validate_review_status("mastered").is_ok());
    }

    #[test]
    fn validate_review_status_rejects_unknown_value() {
        let err = validate_review_status("archived").unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("Invalid review_status")),
            "expected Validation error mentioning Invalid review_status, got: {err:?}"
        );
    }

    #[test]
    fn validate_review_status_rejects_empty_string() {
        assert!(validate_review_status("").is_err());
    }

    #[test]
    fn validate_review_status_rejects_case_variants() {
        // 枚举值是大小写敏感的，"New" / "MASTERED" 都不应通过
        assert!(validate_review_status("New").is_err());
        assert!(validate_review_status("MASTERED").is_err());
    }

    // ── validate_record_type ──

    #[test]
    fn validate_record_type_accepts_all_known_types() {
        for t in [
            "correct",
            "writing",
            "reading",
            "listening",
            "speaking",
            "exercise",
        ] {
            assert!(
                validate_record_type(t).is_ok(),
                "expected '{t}' to be valid"
            );
        }
    }

    #[test]
    fn validate_record_type_rejects_unknown_value() {
        let err = validate_record_type("translate").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // ── validate_goal_type ──

    #[test]
    fn validate_goal_type_accepts_all_known_types() {
        for t in [
            "review",
            "exercise",
            "reading",
            "writing",
            "listening",
            "speaking",
        ] {
            assert!(validate_goal_type(t).is_ok(), "expected '{t}' to be valid");
        }
    }

    #[test]
    fn validate_goal_type_rejects_unknown_value() {
        assert!(validate_goal_type("translate").is_err());
    }

    // ── validate_difficulty_level ──

    #[test]
    fn validate_difficulty_level_accepts_all_known_levels() {
        for l in ["A2", "B1", "B1+", "B2", "B2+", "C1"] {
            assert!(
                validate_difficulty_level(Some(l)).is_ok(),
                "expected '{l}' to be valid"
            );
        }
    }

    #[test]
    fn validate_difficulty_level_accepts_none() {
        assert!(validate_difficulty_level(None).is_ok());
    }

    #[test]
    fn validate_difficulty_level_rejects_unknown_value() {
        let err = validate_difficulty_level(Some("C2")).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("Invalid difficulty_level")),
            "expected Validation error mentioning Invalid difficulty_level, got: {err:?}"
        );
    }

    #[test]
    fn validate_difficulty_level_rejects_empty_string() {
        // difficulty_level 无清空语义：空串与非法值一样拒绝
        assert!(validate_difficulty_level(Some("")).is_err());
    }

    #[test]
    fn validate_difficulty_level_rejects_case_variants() {
        assert!(validate_difficulty_level(Some("b2")).is_err());
    }

    // ── validate_word_level ──

    #[test]
    fn validate_word_level_accepts_all_known_levels() {
        for l in [
            "小学", "中考", "高考", "CET-4", "CET-6", "考研", "TEM-4", "TEM-8", "雅思", "托福",
            "超纲",
        ] {
            assert!(
                validate_word_level(Some(l)).is_ok(),
                "expected '{l}' to be valid"
            );
        }
    }

    #[test]
    fn validate_word_level_accepts_none_and_empty_string() {
        // None：未标注；空串：update_word_level 的清空语义
        assert!(validate_word_level(None).is_ok());
        assert!(validate_word_level(Some("")).is_ok());
    }

    #[test]
    fn validate_word_level_rejects_unknown_value() {
        let err = validate_word_level(Some("GRE")).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("invalid word level")),
            "expected Validation error mentioning invalid word level, got: {err:?}"
        );
    }

    #[test]
    fn validate_word_level_rejects_cefr_codes() {
        // CEFR 级别码属于 difficulty_level 口径，不是词汇等级标签
        assert!(validate_word_level(Some("B2")).is_err());
    }
}
