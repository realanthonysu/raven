//! Raven 桌面应用可执行入口。
//!
//! 本 crate 是 Tauri 应用的二进制入口点，仅负责调用 `raven_lib::run()` 启动应用。
//! 所有业务逻辑、数据库操作和 Tauri Command 定义均位于 `raven_lib`（src/lib.rs）中。

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 程序入口 —— 委托给 `raven_lib::run()` 完成应用初始化与启动。
fn main() {
    raven_lib::run()
}
