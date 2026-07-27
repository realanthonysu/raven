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

mod export;
mod history;
mod learning;
mod models;
mod settings;
pub mod traits;
mod words;

// Re-exports for backward compatibility. Command layer now uses trait methods,
// but free functions are still used internally by the trait impl (traits.rs).
#[allow(unused_imports)]
pub use export::*;
#[allow(unused_imports)]
pub use history::*;
#[allow(unused_imports)]
pub use learning::*;
#[allow(unused_imports)]
pub use models::*;
#[allow(unused_imports)]
pub use settings::*;
#[allow(unused_imports)]
pub use words::*;

use crate::error::AppError;

// ============================================================================
// String enum validation (防止前端传入非法枚举值破坏查询语义)
// ============================================================================

/// 校验 review_status 参数。合法值: new / learning / mastered。
pub(crate) fn validate_review_status(status: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &["new", "learning", "mastered"];
    if VALID.contains(&status) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
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
        Err(AppError::Database(format!(
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
        Err(AppError::Database(format!(
            "Invalid goal_type: '{goal_type}'. Expected one of: review, exercise, reading, writing, listening, speaking"
        )))
    }
}

/// 从 OS Keychain 读取 API Key，失败时降级为空字符串。
///
/// 消除 `get_default_model` 和 `get_first_model` 中重复的 Keychain 读取 + 日志 + fallback 逻辑。
pub(crate) fn get_api_key_or_empty(model_id: i64) -> String {
    match crate::credentials::get_key(model_id) {
        Ok(Some(k)) => k,
        Ok(None) => String::new(),
        Err(e) => {
            tracing::warn!(error = %e, model_id, "keychain read failed");
            String::new()
        }
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
            matches!(err, AppError::Database(ref m) if m.contains("Invalid review_status")),
            "expected Database error mentioning Invalid review_status, got: {err:?}"
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
        assert!(matches!(err, AppError::Database(_)));
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
}
