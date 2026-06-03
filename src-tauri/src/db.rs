/// 数据库连接管理 + 迁移运行器。
///
/// 替代 tauri-plugin-sql，直接使用 rusqlite 操作 SQLite。
/// 好处：
/// 1. SQL 不再暴露给前端（收窄攻击面）
/// 2. 编译期类型检查（通过 rusqlite 的 typed API）
/// 3. 更好的错误处理和事务控制
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// 线程安全的数据库连接包装，通过 Tauri State 注入到所有 Command。
pub struct Db(pub Mutex<Connection>);

/// 迁移定义：版本号 + 描述 + SQL 脚本。
struct MigrationDef {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

/// 所有迁移脚本，按版本号顺序排列。
/// 使用 include_str! 在编译期嵌入，避免运行时文件路径问题。
const MIGRATIONS: &[MigrationDef] = &[
    MigrationDef { version: 1, description: "create_initial_tables", sql: include_str!("../migrations/001_init.sql") },
    MigrationDef { version: 2, description: "add_columns", sql: include_str!("../migrations/002_add_columns.sql") },
    MigrationDef { version: 3, description: "add_review_columns", sql: include_str!("../migrations/003_add_review_columns.sql") },
    MigrationDef { version: 4, description: "add_graph_data", sql: include_str!("../migrations/004_add_graph_data.sql") },
    MigrationDef { version: 5, description: "add_learning_streaks", sql: include_str!("../migrations/005_add_streak.sql") },
    MigrationDef { version: 6, description: "add_learning_goals", sql: include_str!("../migrations/006_add_goals.sql") },
];

/// 打开（或创建）数据库连接，并确保所有迁移已执行。
///
/// `app_data_dir` 由 Tauri 的 PathResolver 提供，对应 Windows 上的
/// `%APPDATA%/com.raven.app/` 目录。数据库文件为 `raven.db`。
pub fn open_and_migrate(db_path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open db: {e}"))?;

    // 启用 WAL 模式以提升并发读写性能
    conn.execute_batch("PRAGMA journal_mode=WAL;").ok();

    run_migrations(&conn)?;
    Ok(conn)
}

/// 按版本号顺序执行迁移。使用 `_migrations` 表跟踪已执行的版本。
///
/// 向后兼容逻辑：
/// - 如果存在旧的 `api_key` 列（来自 tauri-plugin-sql 版本），将其迁移到 OS Keychain 并删除。
fn run_migrations(conn: &Connection) -> Result<(), String> {
    // 创建迁移跟踪表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ).map_err(|e| format!("Failed to create _migrations table: {e}"))?;

    // 获取已执行的版本号
    let applied: HashSet<i64> = {
        let mut stmt = conn.prepare("SELECT version FROM _migrations ORDER BY version")
            .map_err(|e| e.to_string())?;
        let rows: HashSet<i64> = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }
        conn.execute_batch(migration.sql)
            .map_err(|e| format!("Migration {} failed: {e}", migration.description))?;
        conn.execute(
            "INSERT INTO _migrations (version, description) VALUES (?1, ?2)",
            rusqlite::params![migration.version, migration.description],
        ).map_err(|e| format!("Failed to record migration {}: {e}", migration.description))?;
    }

    // 向后兼容：将旧的 api_key 列从 models 表迁移到 OS Keychain，然后删除该列
    migrate_api_key_column(conn)?;

    Ok(())
}

/// 如果 models 表仍有 api_key 列（旧版 tauri-plugin-sql 架构），
/// 将已有的 api_key 值迁移到 OS Keychain，然后删除该列。
fn migrate_api_key_column(conn: &Connection) -> Result<(), String> {
    // 检查 api_key 列是否存在
    let has_api_key: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(models)")
            .map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt.query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        names.iter().any(|name| name == "api_key")
    };

    if !has_api_key {
        return Ok(());
    }

    // 迁移已有的 api_key 到 Keychain
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, api_key FROM models WHERE api_key IS NOT NULL AND api_key != ''")
            .map_err(|e| e.to_string())?;
        let items: Vec<(i64, String)> = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        items
    };

    for (id, key) in rows {
        // 自动解码旧版 Base64 编码的 key
        let decoded = decode_legacy_base64(&key);
        if let Err(e) = crate::credentials::store_key(id, &decoded) {
            eprintln!("[migration] Failed to migrate api_key for model {id}: {e}");
        }
    }

    // SQLite 3.35.0+ 支持 ALTER TABLE DROP COLUMN（rusqlite bundled 使用 3.44+）
    conn.execute_batch("ALTER TABLE models DROP COLUMN api_key;")
        .map_err(|e| format!("Failed to drop api_key column: {e}"))?;

    Ok(())
}

/// 解码旧版 Base64 混淆的 API Key（与前端 credential.ts 的 deobfuscate 逻辑一致）。
/// 如果不是合法 Base64（旧版明文数据），原样返回。
fn decode_legacy_base64(s: &str) -> String {
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(s) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| s.to_string()),
        Err(_) => s.to_string(),
    }
}
