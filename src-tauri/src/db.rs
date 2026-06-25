/// 数据库连接管理 + 迁移运行器。
///
/// 替代 tauri-plugin-sql，直接使用 rusqlite 操作 SQLite。
/// 好处：
/// 1. SQL 不再暴露给前端（收窄攻击面）
/// 2. 编译期类型检查（通过 rusqlite 的 typed API）
/// 3. 更好的错误处理和事务控制
use std::collections::HashSet;
use std::path::PathBuf;

use crate::error::AppError;

/// 线程安全的数据库连接池，通过 Tauri State 注入到所有 Command。
///
/// P2-1: 使用 r2d2 连接池替代单 Mutex<Connection>，支持并发读取。
/// 连接池大小默认为 5，通过 `with_db!` 宏从池中获取连接。
pub struct Db(pub r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>);

/// 创建连接池的配置。
/// WAL 模式允许多个读连接并发，但写操作仍需串行化。
pub fn create_pool(db_path: &PathBuf) -> Result<Db, AppError> {
    let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path)
        .with_init(|c| c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;"));
    let pool = r2d2::Pool::builder()
        .max_size(5)
        .build(manager)
        .map_err(|e| AppError::Database(format!("Failed to create connection pool: {e}")))?;

    // 在池中的第一个连接上执行迁移
    let mut conn = pool
        .get()
        .map_err(|e| AppError::Database(format!("Failed to get connection from pool: {e}")))?;
    run_migrations(&mut conn)?;
    tracing::debug!("Database connection pool created and migrations completed");
    Ok(Db(pool))
}

/// 迁移定义：版本号 + 描述 + SQL 脚本。
struct MigrationDef {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

/// 所有迁移脚本，按版本号顺序排列。
/// 使用 include_str! 在编译期嵌入，避免运行时文件路径问题。
const MIGRATIONS: &[MigrationDef] = &[
    MigrationDef {
        version: 1,
        description: "create_initial_tables",
        sql: include_str!("../migrations/001_init.sql"),
    },
    MigrationDef {
        version: 2,
        description: "add_columns",
        sql: include_str!("../migrations/002_add_columns.sql"),
    },
    MigrationDef {
        version: 3,
        description: "add_review_columns",
        sql: include_str!("../migrations/003_add_review_columns.sql"),
    },
    MigrationDef {
        version: 4,
        description: "add_graph_data",
        sql: include_str!("../migrations/004_add_graph_data.sql"),
    },
    MigrationDef {
        version: 5,
        description: "add_learning_streaks",
        sql: include_str!("../migrations/005_add_streak.sql"),
    },
    MigrationDef {
        version: 6,
        description: "add_learning_goals",
        sql: include_str!("../migrations/006_add_goals.sql"),
    },
    MigrationDef {
        version: 7,
        description: "upgrade_srs_to_fsrs",
        sql: include_str!("../migrations/007_upgrade_srs.sql"),
    },
    MigrationDef {
        version: 8,
        description: "add_composite_indexes",
        sql: include_str!("../migrations/008_add_indexes.sql"),
    },
];

/// 按版本号顺序执行迁移。使用 `_migrations` 表跟踪已执行的版本。
///
/// 向后兼容逻辑：
/// - 如果存在旧的 `api_key` 列（来自 tauri-plugin-sql 版本），将其迁移到 OS Keychain 并删除。
fn run_migrations(conn: &mut rusqlite::Connection) -> Result<(), AppError> {
    // 创建迁移跟踪表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ).map_err(|e| AppError::Database(format!("Failed to create _migrations table: {e}")))?;

    // 获取已执行的版本号
    let applied: HashSet<i64> = {
        let mut stmt = conn.prepare("SELECT version FROM _migrations ORDER BY version")?;
        let rows: Vec<i64> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().collect()
    };

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }
        // 每个迁移包裹在事务中，保证原子性：失败时自动回滚，不会处于半迁移状态
        let tx = conn.transaction().map_err(|e| {
            AppError::Database(format!(
                "Failed to begin transaction for migration {}: {e}",
                migration.description
            ))
        })?;
        tx.execute_batch(migration.sql).map_err(|e| {
            AppError::Database(format!("Migration {} failed: {e}", migration.description))
        })?;
        tx.execute(
            "INSERT INTO _migrations (version, description) VALUES (?1, ?2)",
            rusqlite::params![migration.version, migration.description],
        )
        .map_err(|e| {
            AppError::Database(format!(
                "Failed to record migration {}: {e}",
                migration.description
            ))
        })?;
        tx.commit().map_err(|e| {
            AppError::Database(format!(
                "Failed to commit migration {}: {e}",
                migration.description
            ))
        })?;
    }

    // 向后兼容：将旧的 api_key 列从 models 表迁移到 OS Keychain，然后删除该列
    if let Err(e) = migrate_api_key_column(conn) {
        tracing::error!(error = %e, "api_key column migration failed");
        return Err(e);
    }
    tracing::debug!("Database migrations completed successfully");
    Ok(())
}

/// 如果 models 表仍有 api_key 列（旧版 tauri-plugin-sql 架构），
/// 将已有的 api_key 值迁移到 OS Keychain，然后删除该列。
///
/// R11 优化：
/// - 将列存在性检查移到事务外，避免无列时启动不必要的事务
/// - 利用 R3 的 From<rusqlite::Error> 转换，用 `?` 替换冗余的
///   `.map_err(|e| AppError::Database(e.to_string()))`
fn migrate_api_key_column(conn: &mut rusqlite::Connection) -> Result<(), AppError> {
    // 1. 先检查 api_key 列是否存在（无需事务）
    let has_api_key: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(models)")?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        names.iter().any(|name| name == "api_key")
    };

    if !has_api_key {
        return Ok(());
    }

    // 2. 列存在，启动事务执行迁移
    let tx = conn.transaction().map_err(|e| {
        AppError::Database(format!(
            "Failed to begin api_key migration transaction: {e}"
        ))
    })?;

    // 迁移已有的 api_key 到 Keychain
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, api_key FROM models WHERE api_key IS NOT NULL AND api_key != ''",
        )?;
        let items: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        items
    };

    for (id, key) in rows {
        // 自动解码旧版 Base64 编码的 key
        let decoded = decode_legacy_base64(&key);
        if let Err(e) = crate::credentials::store_key(id, &decoded) {
            // 中止事务——不删除列，下次启动时重试
            return Err(AppError::Database(format!(
                "Failed to migrate api_key for model {id} to keychain: {e}. \
                 Migration will retry on next startup."
            )));
        }
    }

    // SQLite 3.35.0+ 支持 ALTER TABLE DROP COLUMN（rusqlite bundled 使用 3.44+）
    tx.execute_batch("ALTER TABLE models DROP COLUMN api_key;")
        .map_err(|e| AppError::Database(format!("Failed to drop api_key column: {e}")))?;

    tx.commit()
        .map_err(|e| AppError::Database(format!("Failed to commit api_key migration: {e}")))?;
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
