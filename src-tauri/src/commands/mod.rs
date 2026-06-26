//! Tauri Command handler 模块 —— 前端通过 `invoke()` 调用的入口。
//!
//! 命名约定：Rust 端 snake_case，前端 invoke() 自动转换为 camelCase。
//!
//! P2-8: 按领域拆分为子模块，mod.rs 仅负责声明。
//!
//! ## 子模块职责
//!
//! - [`shared`] - 共享类型（DTO、枚举、行映射器、`with_db!` 宏）
//! - [`models`] - 模型配置 CRUD（含 OS Keychain 集成）
//! - [`words`] - 生词本 CRUD + 复习调度
//! - [`history`] - 学习历史记录
//! - [`settings`] - 键值对设置 + TTS 配置
//! - [`learning`] - 学习打卡 + 目标管理
//! - [`fsrs`] - FSRS 间隔重复算法 Command
//! - [`export`] - 导出 + 备份 + 文件写入

pub(crate) mod shared;

pub mod export;
pub mod fsrs;
pub mod history;
pub mod learning;
pub mod models;
pub mod settings;
pub mod words;
