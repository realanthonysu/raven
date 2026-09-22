//! 共享类型、工具宏 —— 供所有 Command 子模块使用。
//!
//! DTO 与行映射器已下沉至 [`crate::dto`]（repository 与 commands 共同依赖，
//! 消除 repository → commands 的依赖倒置）。本模块再导出这些类型以保持
//! 命令侧导入路径稳定，并保留连接池辅助宏 [`with_db!`]/[`with_db_read!`]。

// 再导出领域 DTO：命令层继续 `use crate::commands::shared::XxxDto` 即可。
pub use crate::dto::*;

// ============================================================================
// Helper macro: get connection from pool + error conversion
// ============================================================================

/// 从连接池获取只读数据库连接并执行闭包体。
///
/// 与 `with_db!` 不同，此宏传入 `&Connection`（不可变引用），
/// 允许多个并发读操作真正并行。
///
/// 用法：`with_db_read!(db_state, |conn: &Connection| { ... })`
///
/// 通过 `tokio::task::spawn_blocking` 在阻塞线程池执行 SQLite 操作——
/// 避免在 async runtime 线程上同步执行 rusqlite。
macro_rules! with_db_read {
    ($db:expr, $body:expr) => {{
        let pool = $db.0.clone();
        ::tokio::task::spawn_blocking(move || {
            let conn = pool
                .get()
                .map_err(|e| crate::error::AppError::Database(format!("DB pool error: {e}")))?;
            #[allow(clippy::redundant_closure_call)]
            {
                (|| -> Result<_, crate::error::AppError> { $body(&*conn) })()
            }
        })
        .await
        .map_err(|e| crate::error::AppError::Database(format!("db task panicked: {e}")))?
    }};
}
pub(crate) use with_db_read;

/// 从连接池获取可写数据库连接并执行闭包体，自动将池错误转换为 `AppError::Database`。
///
/// 用法：`with_db!(db_state, |conn: &mut Connection| { ... })`
///
/// 仅在需要事务（`conn.transaction()`）时使用；只读操作请用 `with_db_read!`。
macro_rules! with_db {
    ($db:expr, $body:expr) => {{
        let pool = $db.0.clone();
        ::tokio::task::spawn_blocking(move || {
            let mut conn = pool
                .get()
                .map_err(|e| crate::error::AppError::Database(format!("DB pool error: {e}")))?;
            #[allow(clippy::redundant_closure_call)]
            {
                (|| -> Result<_, crate::error::AppError> { $body(&mut *conn) })()
            }
        })
        .await
        .map_err(|e| crate::error::AppError::Database(format!("db task panicked: {e}")))?
    }};
}
pub(crate) use with_db;
