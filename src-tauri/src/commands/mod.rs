/// Tauri Command handlers - frontend invokes these via invoke().
///
/// Naming convention: Rust-side snake_case, frontend invoke() auto-converts to camelCase.
///
/// P2-8: 按领域拆分为子模块，mod.rs 仅负责声明。
pub(crate) mod shared;

pub mod export;
pub mod fsrs;
pub mod history;
pub mod learning;
pub mod models;
pub mod settings;
pub mod words;
