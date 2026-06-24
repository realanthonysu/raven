use std::sync::Mutex;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // HTTP 插件：前端通过此插件调用 LLM API（SSE 流式请求）
        // 注意：capabilities/default.json 中 HTTP scope 仅允许常见 LLM API 域名
        // （OpenAI / DeepSeek / Anthropic / Azure OpenAI）以及 localhost（本地 Ollama）。
        // 如需支持其他 LLM 提供商，需在 capabilities/default.json 中添加对应域名。
        .plugin(tauri_plugin_http::init())
        // opener 插件：提供用系统默认应用打开文件/URL 的能力
        .plugin(tauri_plugin_opener::init())
        // dialog 插件：文件保存/选择对话框（导出、备份时使用）
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 开发模式下自动打开 DevTools
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
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
            let conn = db::open_and_migrate(&db_path).expect("Failed to initialize database");

            // 将数据库连接注入 Tauri State，供所有 Command 使用
            app.manage(db::Db(Mutex::new(conn)));

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
                .icon(app.default_window_icon().unwrap().clone())
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
            commands::get_models,
            commands::add_model,
            commands::delete_model,
            commands::get_default_model,
            commands::set_default_model,
            commands::update_model,
            // 生词本
            commands::db_add_word,
            commands::db_get_words,
            commands::db_delete_word,
            commands::db_update_word_level,
            commands::db_update_word_enrichment,
            commands::db_get_review_stats,
            commands::db_get_review_words,
            commands::db_update_word_review,
            // 历史记录
            commands::db_add_history,
            commands::db_get_history,
            commands::db_get_history_list,
            commands::db_get_history_by_id,
            commands::db_delete_history,
            commands::db_update_history_graph_data,
            commands::db_get_recent_correct_results,
            // 设置
            commands::db_get_setting,
            commands::db_set_setting,
            // 学习打卡
            commands::db_record_learning_activity,
            commands::db_get_all_streaks,
            commands::db_get_today_activities,
            // 学习目标
            commands::db_get_learning_goals,
            commands::db_set_learning_goal,
            // TTS 配置
            commands::db_get_tts_config,
            commands::db_set_tts_setting,
            // Phase 3: 算法 + 导出 + 备份
            commands::calculate_next_review,
            commands::db_update_word_review_fsrs,
            commands::export_words_csv,
            commands::export_words_anki,
            commands::backup_db,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
