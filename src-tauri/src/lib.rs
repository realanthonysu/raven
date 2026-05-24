#[cfg(debug_assertions)]
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// 应用入口函数。
///
/// 负责三件事：
/// 1. 注册 Tauri 插件（HTTP、文件打开、数据库）
/// 2. 将 SQL 迁移脚本绑定到 SQLite 数据库
/// 3. 配置调试环境并启动应用
///
/// 在移动端编译时，此函数会被标记为移动入口点。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 数据库迁移列表，按版本号顺序执行。
    // 使用 include_str! 在编译期将 SQL 文件嵌入二进制，避免运行时文件路径问题。
    // MigrationKind::Up 表示只执行正向迁移（无回滚支持），
    // 因为 SQLite 的 ALTER TABLE 能力有限，回滚迁移在实际中很难维护。
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_columns",
            sql: include_str!("../migrations/002_add_columns.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_review_columns",
            sql: include_str!("../migrations/003_add_review_columns.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_graph_data",
            sql: include_str!("../migrations/004_add_graph_data.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // HTTP 插件：前端通过此插件发起跨域 HTTP 请求（如调用 LLM API），
        // 绕过浏览器同源策略限制。需要在 capabilities 中配置允许的 URL 范围。
        .plugin(tauri_plugin_http::init())
        // opener 插件：提供用系统默认应用打开文件/URL 的能力（如打开外部链接）。
        .plugin(tauri_plugin_opener::init())
        // SQL 插件：提供前端可直接调用的 SQLite 数据库接口。
        // "sqlite:raven.db" 表示数据库文件存储在应用数据目录下名为 raven.db 的文件中。
        // 迁移脚本在数据库首次打开时按版本号依次执行，已执行的会跳过。
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:raven.db", migrations)
                .build(),
        )
        // invoke_handler 注册 Rust 端可供前端 invoke 的命令。
        // 当前为空数组——所有业务逻辑通过前端直接操作 SQL 插件和 HTTP 插件完成，
        // 没有自定义的 Tauri 命令。如果未来需要在 Rust 端处理复杂逻辑，可在此添加。
        .invoke_handler(tauri::generate_handler![])
        .setup(|_app| {
            // 开发模式下自动打开 DevTools，方便调试。
            // cfg(debug_assertions) 确保此代码不会编译进发布版本。
            #[cfg(debug_assertions)]
            {
                let window = _app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
