use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;
/// 应用入口 —— 注册插件、初始化数据库、配置系统托盘、启动 Tauri 应用。
///
/// 架构变更（v2）：
/// - 移除 tauri-plugin-sql，改用 rusqlite 直接操作 SQLite
/// - API Key 存储在 OS Keychain（通过 keyring crate），不再写入数据库
/// - 所有数据库操作通过 Tauri Command 暴露给前端
/// - 系统托盘：关闭窗口时最小化到托盘而非退出
#[cfg(debug_assertions)]
use tauri::Manager;

mod commands;
mod credentials;
mod db;
mod error;
mod fsrs;
mod repository;

/// 初始化 tracing 结构化日志。
///
/// 默认日志级别：debug 模式下 `debug`，release 模式下 `info`。
/// 可通过环境变量 `RUST_LOG` 覆盖。
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = if cfg!(debug_assertions) {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"))
    } else {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    };
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("Raven application starting");

    tauri::Builder::default()
        // HTTP 插件：前端通过此插件调用 LLM API（SSE 流式请求）
        // 注意：capabilities/default.json 中 HTTP scope 允许任意 HTTPS 端点
        // （用户可自定义任意 OpenAI 兼容 Base URL），HTTP 仅限本地回环（防 SSRF）。
        .plugin(tauri_plugin_http::init())
        // opener 插件：提供用系统默认应用打开文件/URL 的能力
        .plugin(tauri_plugin_opener::init())
        // dialog 插件：文件保存/选择对话框（导出、备份时使用）
        .plugin(tauri_plugin_dialog::init())
        // notification 插件：原生系统通知（每日复习提醒）
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 开发模式下自动打开 DevTools
            #[cfg(debug_assertions)]
            {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| "main window not found in tauri.conf.json".to_string())?;
                window.open_devtools();
            }

            // 初始化数据库：在 Tauri app data 目录下创建/打开 raven.db
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("Failed to create app data directory: {e}"))?;

            let db_path = data_dir.join("raven.db");
            let db_pool = db::create_pool(&db_path).unwrap_or_else(|e| {
                tracing::error!(error = %e, "Failed to initialize database");
                panic!("Failed to initialize database: {e}");
            });

            // 将数据库连接池注入 Tauri State，供所有 Command 使用
            app.manage(db_pool);

            // === 系统托盘 ===
            // 构建托盘菜单：显示主窗口 / 退出应用
            let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // 创建托盘图标
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or_else(|| "default window icon not configured".to_string())?
                        .clone(),
                )
                .tooltip("Raven — 英语学习助手")
                .menu(&tray_menu)
                // 左键单击托盘图标：显示主窗口
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                })
                // 托盘菜单项点击事件
                .on_menu_event(move |app: &AppHandle, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().ok();
                            window.set_focus().ok();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // 窗口关闭事件：最小化到托盘而非退出应用
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 阻止默认关闭行为，改为隐藏窗口（最小化到托盘）
                api.prevent_close();
                window.hide().ok();
            }
        })
        // 注册所有 Tauri Command —— 前端通过 invoke() 调用
        .invoke_handler(tauri::generate_handler![
            // 模型配置（OS Keychain 集成）
            commands::models::get_models,
            commands::models::add_model,
            commands::models::delete_model,
            commands::models::get_default_model,
            commands::models::set_default_model,
            commands::models::update_model,
            commands::models::get_model_api_key,
            // 生词本
            commands::words::db_add_word,
            commands::words::db_get_words,
            commands::words::db_delete_word,
            commands::words::db_update_word_level,
            commands::words::db_update_word_enrichment,
            commands::words::db_get_review_stats,
            commands::words::db_get_review_words,
            commands::words::db_update_word_review,
            // 历史记录
            commands::history::db_add_history,
            commands::history::db_get_history,
            commands::history::db_get_history_list,
            commands::history::db_get_history_by_id,
            commands::history::db_delete_history,
            commands::history::db_update_history_graph_data,
            commands::history::db_get_recent_correct_results,
            // 设置
            commands::settings::db_get_setting,
            commands::settings::db_set_setting,
            // 学习打卡
            commands::learning::db_record_learning_activity,
            commands::learning::db_get_all_streaks,
            commands::learning::db_get_today_activities,
            // 学习目标
            commands::learning::db_get_learning_goals,
            commands::learning::db_set_learning_goal,
            // TTS 配置
            commands::settings::db_get_tts_config,
            commands::settings::db_set_tts_setting,
            // Phase 3: 算法 + 导出 + 备份
            commands::fsrs::calculate_next_review,
            commands::fsrs::db_update_word_review_fsrs,
            commands::export::export_words_csv,
            commands::export::export_words_anki,
            commands::export::backup_db,
            commands::export::write_text_file,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "Tauri application error");
            panic!("error while running tauri application: {e}");
        });
}
