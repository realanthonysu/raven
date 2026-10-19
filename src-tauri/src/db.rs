//! 数据库连接管理 + 迁移运行器。
//!
//! 替代 tauri-plugin-sql，直接使用 rusqlite 操作 SQLite。
//! 好处：
//! 1. SQL 不再暴露给前端（收窄攻击面）
//! 2. 编译期类型检查（通过 rusqlite 的 typed API）
//! 3. 更好的错误处理和事务控制

use std::collections::HashSet;
use std::path::PathBuf;

use crate::error::AppError;

/// 线程安全的数据库连接池，通过 Tauri State 注入到所有 Command。
///
/// P2-1: 使用 r2d2 连接池替代单 Mutex<Connection>，支持并发读取。
/// 连接池大小默认为 5，通过 `with_db!` 宏从池中获取连接。
pub struct Db(
    /// r2d2 连接池实例，底层使用 rusqlite 的 SQLite 连接。
    pub r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
);

/// 创建连接池的配置。
/// WAL 模式允许多个读连接并发，但写操作仍需串行化。
///
/// 每个连接的初始化 PRAGMA：
/// - `busy_timeout=5000`：写锁竞争时等待 5s 而非立即报 SQLITE_BUSY
/// - `synchronous=NORMAL`：WAL 模式下的推荐级别，写性能显著优于 FULL 且不牺牲崩溃一致性
pub fn create_pool(db_path: &PathBuf) -> Result<Db, AppError> {
    let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path).with_init(|c| {
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; \
             PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;",
        )
    });
    let pool = r2d2::Pool::builder()
        .max_size(5)
        // 预热 1 个连接，避免首个请求承担建连 + 迁移开销；获取连接超时 10s
        // （busy_timeout 5s + 排队余量），超时报错而非无限等待
        .min_idle(Some(1))
        .connection_timeout(std::time::Duration::from_secs(10))
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
    /// 迁移版本号（单调递增，用于判断是否已执行）。
    version: i64,
    /// 迁移描述（记录到 `_migrations` 表，便于排查问题）。
    description: &'static str,
    /// 编译期嵌入的 SQL 迁移脚本（通过 `include_str!` 加载）。
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
    MigrationDef {
        version: 9,
        description: "cleanup_redundant_indexes",
        sql: include_str!("../migrations/009_cleanup_indexes.sql"),
    },
    MigrationDef {
        version: 10,
        description: "repair_srs_backfill_and_restore_history_created_index",
        sql: include_str!("../migrations/010_repair_srs_backfill_and_index.sql"),
    },
    MigrationDef {
        version: 11,
        description: "next_review_at_local_to_utc",
        sql: include_str!("../migrations/011_next_review_at_to_utc.sql"),
    },
    MigrationDef {
        version: 12,
        description: "api_key_default_noop_placeholder",
        sql: include_str!("../migrations/012_api_key_default.sql"),
    },
    MigrationDef {
        version: 13,
        description: "words_unique_lower_word_index",
        sql: include_str!("../migrations/013_words_unique_lower.sql"),
    },
    MigrationDef {
        version: 14,
        description: "history_difficulty_level_column",
        sql: include_str!("../migrations/014_add_difficulty_level.sql"),
    },
];

/// 按版本号顺序执行迁移。使用 `_migrations` 表跟踪已执行的版本。
///
/// checksum 校验：对每个已应用的迁移记录其 SQL 文本的 FNV-1a 64 位哈希。
/// - 首次执行时写入 checksum；对历史遗留（无 checksum 列/值为 NULL）的已应用迁移，
///   按当前 SQL 回填（假定未被篡改——无法恢复历史文本）。
/// - mismatch 时**仅告警不硬失败**。取舍：硬失败会把"某个旧迁移文件在后续版本被
///   合法修订过"的正常场景变成启动砖块；而 checksum 的主要价值是发现意外漂移
///   （手工改动迁移文件、分支合并冲突残留），告警足以提示人工核查。
///
/// 向后兼容逻辑：
/// - 如果存在旧的 `api_key` 列（来自 tauri-plugin-sql 版本），先把它修复为
///   带 DEFAULT 的列（解毒 NOT NULL 无默认值的毒化状态），再尝试迁移到
///   OS Keychain 并删除该列。
fn run_migrations(conn: &mut rusqlite::Connection) -> Result<(), AppError> {
    // 创建迁移跟踪表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ).map_err(|e| AppError::Database(format!("Failed to create _migrations table: {e}")))?;

    // 为 _migrations 补充 checksum 列（SQLite 无 ADD COLUMN IF NOT EXISTS，
    // 依赖 "duplicate column" 错误做幂等短路）
    if let Err(e) = conn.execute_batch("ALTER TABLE _migrations ADD COLUMN checksum TEXT") {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(AppError::Database(format!(
                "Failed to add checksum column to _migrations: {e}"
            )));
        }
    }

    // 获取已执行的版本号及其记录的 checksum
    type AppliedRow = (i64, Option<String>);
    let applied: Vec<AppliedRow> = {
        let mut stmt =
            conn.prepare("SELECT version, checksum FROM _migrations ORDER BY version")?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?
    };
    let applied_versions: HashSet<i64> = applied.iter().map(|(v, _)| *v).collect();

    // 对已应用但无 checksum 记录的迁移回填当前 SQL 的哈希
    for (version, checksum) in &applied {
        if checksum.is_none()
            && let Some(m) = MIGRATIONS.iter().find(|m| m.version == *version)
        {
            let hash = sql_checksum(m.sql);
            conn.execute(
                "UPDATE _migrations SET checksum = ?1 WHERE version = ?2",
                rusqlite::params![hash, version],
            )?;
        }
    }

    for migration in MIGRATIONS {
        if !applied_versions.contains(&migration.version) {
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
                "INSERT INTO _migrations (version, description, checksum) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    migration.version,
                    migration.description,
                    sql_checksum(migration.sql)
                ],
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
            continue;
        }

        // 已应用：校验 checksum，mismatch 告警但不阻断启动（见函数注释的取舍说明）
        let recorded: Option<String> = {
            let mut stmt = conn.prepare("SELECT checksum FROM _migrations WHERE version = ?1")?;
            stmt.query_row(rusqlite::params![migration.version], |row| row.get(0))
                .map_err(|e| {
                    AppError::Database(format!("Failed to read migration checksum: {e}"))
                })?
        };
        if let Some(recorded) = recorded {
            let actual = sql_checksum(migration.sql);
            if actual != recorded {
                tracing::warn!(
                    version = migration.version,
                    description = migration.description,
                    recorded = %recorded,
                    actual = %actual,
                    "migration SQL changed after it was applied; \
                     continuing startup but results may diverge from what was executed"
                );
            }
        }
        // recorded 为 NULL 的情况已在上面回填，这里无需处理
    }

    // 向后兼容：将旧的 api_key 列从 models 表迁移到 OS Keychain，然后删除该列。
    // 失败不再阻塞启动（降级策略见 migrate_api_key_column 文档）；即使失败，
    // 列也会先被修复为 NOT NULL DEFAULT ''（见 rebuild_models_with_api_key_default），
    // 保证 Keychain 不可用的系统上 models 的 INSERT 不再撞 NOT NULL 约束。
    if let Err(e) = migrate_api_key_column(conn) {
        tracing::warn!(
            error = %e,
            "legacy api_key column migration failed; continuing startup — \
             legacy column is left in place and will be retried next launch"
        );
    }
    tracing::debug!("Database migrations completed successfully");
    Ok(())
}

/// FNV-1a 64 位哈希的十六进制表示，用于迁移 SQL 文本的 checksum。
///
/// 选 FNV-1a 而非加密哈希（SHA-256 等）：目的只是检测**意外的**文件漂移，
/// 不对抗主动篡改（攻击者能改迁移文件就能改这段校验代码），因此无需引入额外依赖。
fn sql_checksum(sql: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in sql.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// 如果 models 表仍有 api_key 列（旧版 tauri-plugin-sql 架构），
/// 将已有的 api_key 值迁移到 OS Keychain，然后删除该列。
///
/// 执行顺序（两步各自独立提交）：
/// 1. [`rebuild_models_with_api_key_default`] —— 先把该列修复为
///    `NOT NULL DEFAULT ''`，消除毒化状态；
/// 2. 再尝试 Keychain 迁移 + DROP COLUMN（原有逻辑）。
///
/// 为什么解毒放在 Keychain 迁移**之前**且**独立提交**：
/// - 若放进下面的事务，`store_key` 失败时整体回滚，解毒也随之回滚——而
///   Keychain 不可用（Linux 无 Secret Service 等）恰恰是列被留存、毒化状态
///   持续咬人的场景，解毒必须活过一次失败；
/// - 放在失败路径上补救则要把提交逻辑复制两份，且 Keychain 部分成功后再失败
///   的窗口内毒化状态仍在；
/// - Keychain 完全成功时列随即可删，这次重建只是一次性小表重建，成本可忽略。
///
/// 幂等性：入口处用 PRAGMA table_info 短路——列不存在（含已迁移完成、全新库）
/// 时直接返回 Ok，不产生任何写入。解毒步骤自身再用 dflt_value 短路（列已有
/// 默认值时不再重建）。因此每次启动重复调用是安全的。
///
/// 降级策略（失败不再阻塞启动）：该列**只**服务于 tauri-plugin-sql 时代的遗留数据，
/// 当前所有代码路径均从 OS Keychain 读 key；models 表本身不依赖此列即可工作。
/// 迁移失败时把错误记入日志并返回 Ok 让应用继续启动——后果仅是遗留明文 key
/// 暂留数据库中，下次启动自动重试（事务未提交、列未被删除）。
/// 若改为硬失败，Keychain 偶发不可用（Linux 无 Secret Service 等）会导致整个
/// 应用无法启动，得不偿失。
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

    // 2. 先解毒：把 api_key 修复为 NOT NULL DEFAULT ''（独立事务提交）。
    //    必须在 Keychain 迁移之前——放进下面的事务会因 store_key 失败整体
    //    回滚，详见函数文档的时机说明。
    rebuild_models_with_api_key_default(conn)?;

    // 3. 列存在，启动事务执行迁移
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

/// models 表的预期列序：001_init.sql 的 models 定义 + 002 追加的 created_at。
/// ALTER TABLE ADD COLUMN 只能把列追加在末尾，故 created_at 固定在最后。
const EXPECTED_MODELS_COLUMNS: &[&str] = &[
    "id",
    "name",
    "api_key",
    "base_url",
    "model_name",
    "is_default",
    "created_at",
];

/// 读取 models 表 api_key 列的默认值（`PRAGMA table_info` 的 dflt_value）。
/// 列不存在或表不存在时返回 `None`。
fn api_key_default_value(conn: &rusqlite::Connection) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(models)")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, Option<String>>(4)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .find(|(name, _)| name == "api_key")
        .and_then(|(_, dflt)| dflt))
}

/// 重建 models 表：把遗留的 `api_key TEXT NOT NULL`（无 DEFAULT）改为
/// `api_key TEXT NOT NULL DEFAULT ''`，已有行数据（含遗留明文 key，留给下次
/// 启动重试 Keychain 迁移）全列搬迁保留。
///
/// 背景：001_init.sql 的 models.api_key 定义为 NOT NULL 且无 DEFAULT。Keychain
/// 不可用的系统上 `migrate_api_key_column` 永远删不掉这一列，而
/// `repository::models::add_model` 的 INSERT 不含 api_key，于是每次新增模型都撞
/// NOT NULL 约束——应用事实上残废。不能直接改 001_init.sql（已装库的 checksum
/// 会失配，012 迁移就是这条教训的记录），因此在运行时把这一列修好。
///
/// 实现要点：
/// - 新表逐列照抄 001 的 models 定义（含 002 的 created_at，列序一致），
///   唯一改动是 api_key 加 `DEFAULT ''`；
/// - `INSERT INTO models_new (...) SELECT ... FROM models` 全列显式列出；
/// - DROP + RENAME 包在同一事务里，原子完成；
/// - 入口用 dflt_value 幂等短路：列已有默认值（含上次已重建）时不动作；
/// - models 上的索引随 DROP TABLE 丢失，重建前捕获 DDL、RENAME 后复原
///   （当前各迁移均未在 models 上建索引，这里通用处理防未来迁移被吞）。
fn rebuild_models_with_api_key_default(conn: &mut rusqlite::Connection) -> Result<(), AppError> {
    // 1. 幂等短路：列已有默认值（上次已重建）则不再动作。放在列集校验之前——
    //    无需解毒时列集漂移与本函数无关，不应触发误导性告警。
    if api_key_default_value(conn)?.is_some() {
        return Ok(());
    }

    // 2. 列集校验：与预期结构不一致时拒绝按硬编码 schema 重建——未来迁移若给
    //    models 加了列，照搬这里的 schema 会静默丢数据；宁可保留毒化状态
    //    （并告警提示更新 EXPECTED_MODELS_COLUMNS），也不能丢列。
    let columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(models)")?;
        stmt.query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if columns.iter().map(String::as_str).collect::<Vec<_>>() != EXPECTED_MODELS_COLUMNS {
        tracing::warn!(
            ?columns,
            "models table columns drifted from expected 001+002 layout; \
             skipping api_key DEFAULT rebuild to avoid data loss"
        );
        return Ok(());
    }

    // 3. 捕获 models 上现有索引的 DDL——DROP TABLE 会连索引一起删掉，重建后必须
    //    复原。自动索引（UNIQUE 约束产生）的 sql 为 NULL，随新表结构自动重建，
    //    不需（也不能）手动执行，故以 sql IS NOT NULL 过滤。
    let index_ddls: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT sql FROM sqlite_master \
             WHERE type = 'index' AND tbl_name = 'models' AND sql IS NOT NULL",
        )?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };

    // 4. 标准重建：建新表 → 全列显式搬迁 → DROP 旧表 → RENAME，同一事务原子完成
    let tx = conn.transaction().map_err(|e| {
        AppError::Database(format!("Failed to begin models rebuild transaction: {e}"))
    })?;

    // 逐列照抄 001_init.sql 的 models 定义（列序一致），唯一改动是 api_key 的
    // DEFAULT ''；created_at 对应 002 的 ALTER TABLE ADD COLUMN（可空、无默认值）
    tx.execute_batch(
        "CREATE TABLE models_rebuild (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           api_key TEXT NOT NULL DEFAULT '',
           base_url TEXT NOT NULL,
           model_name TEXT NOT NULL,
           is_default BOOLEAN DEFAULT 0,
           created_at DATETIME
         )",
    )
    .map_err(|e| AppError::Database(format!("Failed to create models_rebuild table: {e}")))?;

    tx.execute(
        "INSERT INTO models_rebuild (id, name, api_key, base_url, model_name, is_default, created_at) \
         SELECT id, name, api_key, base_url, model_name, is_default, created_at FROM models",
        [],
    )
    .map_err(|e| AppError::Database(format!("Failed to copy rows into models_rebuild: {e}")))?;

    tx.execute_batch("DROP TABLE models")
        .map_err(|e| AppError::Database(format!("Failed to drop old models table: {e}")))?;

    tx.execute_batch("ALTER TABLE models_rebuild RENAME TO models")
        .map_err(|e| {
            AppError::Database(format!("Failed to rename models_rebuild to models: {e}"))
        })?;

    // 复原重建前捕获的索引（此时新表已叫回 models，原 DDL 可直接执行）
    for ddl in &index_ddls {
        tx.execute_batch(ddl)
            .map_err(|e| AppError::Database(format!("Failed to restore index ({ddl}): {e}")))?;
    }

    tx.commit()
        .map_err(|e| AppError::Database(format!("Failed to commit models rebuild: {e}")))?;
    Ok(())
}

// ============================================================================
// Test helper — 创建带完整 schema 的内存数据库
// ============================================================================

/// 创建一个已运行全部迁移的内存 SQLite 连接，用于 repository 层集成测试。
///
/// 返回的连接包含完整的表结构（与生产环境一致），但数据为空。
/// 每个测试可独立使用，无需文件系统或 OS Keychain。
///
/// # Example
///
/// ```ignore
/// #[cfg(test)]
/// mod tests {
///     use super::*;
///     use crate::db::create_test_db;
///
///     #[test]
///     fn test_add_word() {
///         let conn = create_test_db();
///         // conn 已有完整的 words/history/settings 等表
///         let id = repository::words::add_word(&conn, &NewWordInput { ... }).unwrap();
///         assert_eq!(id, 1);
///     }
/// }
/// ```
#[cfg(test)]
pub fn create_test_db() -> rusqlite::Connection {
    let mut conn = rusqlite::Connection::open_in_memory()
        .expect("Failed to create in-memory SQLite connection");
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .expect("Failed to enable foreign keys");
    run_migrations(&mut conn).expect("Failed to run migrations on test DB");
    conn
}

// ============================================================================
// Legacy helpers
// ============================================================================

/// 解码旧版 Base64 混淆的 API Key（与前端 credential.ts 的 deobfuscate 逻辑一致）。
/// 如果不是合法 Base64（旧版明文数据），原样返回。
pub fn decode_legacy_base64(s: &str) -> String {
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(s) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| s.to_string()),
        Err(_) => s.to_string(),
    }
}

// ============================================================================
// Unit tests — decode_legacy_base64 + create_test_db 验证
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── decode_legacy_base64 ──

    #[test]
    fn decode_base64_decodes_valid_base64() {
        // "hello" in Base64 is "aGVsbG8="
        let result = decode_legacy_base64("aGVsbG8=");
        assert_eq!(result, "hello");
    }

    #[test]
    fn decode_base64_returns_original_for_invalid_base64() {
        let result = decode_legacy_base64("not-valid-base64!@#");
        assert_eq!(result, "not-valid-base64!@#");
    }

    #[test]
    fn decode_base64_returns_original_for_empty_string() {
        let result = decode_legacy_base64("");
        assert_eq!(result, "");
    }

    #[test]
    fn decode_base64_handles_utf8_content() {
        // "测试" in Base64
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode("测试".as_bytes());
        let result = decode_legacy_base64(&encoded);
        assert_eq!(result, "测试");
    }

    // ── create_test_db ──

    #[test]
    fn create_test_db_has_all_tables() {
        let conn = create_test_db();

        // Verify key tables exist by querying sqlite_master
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert!(tables.contains(&"words".to_string()), "words table missing");
        assert!(
            tables.contains(&"models".to_string()),
            "models table missing"
        );
        assert!(
            tables.contains(&"history".to_string()),
            "history table missing"
        );
        assert!(
            tables.contains(&"settings".to_string()),
            "settings table missing"
        );
        assert!(
            tables.contains(&"_migrations".to_string()),
            "_migrations table missing"
        );
    }

    #[test]
    fn create_test_db_all_migrations_applied() {
        let conn = create_test_db();

        let versions: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT version FROM _migrations ORDER BY version")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        // Should have all 14 migrations applied
        assert_eq!(
            versions,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
            "Expected all migrations applied in order"
        );
    }

    // ── 010 迁移：修复 007 回填缺口 + 恢复全局时间索引 ──

    #[test]
    fn migration_010_repairs_legacy_srs_backfill_and_restores_index() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 模拟已上线用户的库：应用 010 之前的全部迁移
        for m in MIGRATIONS.iter().filter(|m| m.version < 10) {
            conn.execute_batch(m.sql).unwrap();
        }

        // 007 之前的旧行：有复习历史但 FSRS 列为回填的默认 0
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count) VALUES ('legacy_learning', 'd', 'learning', 5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count) VALUES ('legacy_mastered', 'd', 'mastered', 2)",
            [],
        )
        .unwrap();
        // 从未复习的新词：不应被改动
        conn.execute(
            "INSERT INTO words (word, definition) VALUES ('fresh', 'd')",
            [],
        )
        .unwrap();
        // 已进入 FSRS 流程的行：不应被改动
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, stability, difficulty, reps, lapses, state) VALUES ('fsrs_row', 'd', 'learning', 3, 12.0, 6.5, 3, 1, 2)",
            [],
        )
        .unwrap();

        let m010 = MIGRATIONS.iter().find(|m| m.version == 10).unwrap();
        conn.execute_batch(m010.sql).unwrap();

        let get_row = |word: &str| -> (i64, i64, f64, f64) {
            conn.query_row(
                "SELECT state, reps, difficulty, stability FROM words WHERE word = ?1",
                [word],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(-1),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(-1),
                        row.get::<_, Option<f64>>(2)?.unwrap_or(-1.0),
                        row.get::<_, Option<f64>>(3)?.unwrap_or(-1.0),
                    ))
                },
            )
            .unwrap()
        };

        // 旧行被按 review_status 回填
        let (state, reps, difficulty, stability) = get_row("legacy_learning");
        assert_eq!(
            (state, reps),
            (1, 5),
            "learning 旧行应回填 state=1、reps=review_count"
        );
        assert_eq!(
            (difficulty, stability),
            (5.0, 0.5),
            "低于算法下限的值应置为中性起步值"
        );

        let (state, reps, _, _) = get_row("legacy_mastered");
        assert_eq!(
            (state, reps),
            (2, 2),
            "mastered 旧行应回填 state=2、reps=review_count"
        );

        // 新词与已进入 FSRS 流程的行不受影响
        let (state, reps, difficulty, _) = get_row("fresh");
        assert_eq!(
            (state, reps, difficulty),
            (0, 0, 0.0),
            "从未复习的行不应被改动"
        );
        let (state, reps, difficulty, stability) = get_row("fsrs_row");
        assert_eq!(
            (state, reps, difficulty, stability),
            (2, 3, 6.5, 12.0),
            "已进入 FSRS 流程的行不应被改动"
        );

        // idx_history_created 索引被恢复
        let idx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_history_created'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 1, "010 应恢复 idx_history_created 索引");
    }

    // ── 011 迁移：next_review_at 本地时间 → UTC ──

    #[test]
    fn migration_011_converts_local_time_to_utc() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 模拟已上线用户的库：应用 011 之前的全部迁移
        for m in MIGRATIONS.iter().filter(|m| m.version < 11) {
            conn.execute_batch(m.sql).unwrap();
        }

        // 插入"本地时间"的 next_review_at（与旧版 fsrs.rs 写入格式一致）
        let local_now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, next_review_at) VALUES ('w1', 'd', 'learning', 1, ?1)",
            rusqlite::params![local_now],
        )
        .unwrap();
        // NULL 行不应被改动；非法格式的行应保守保留原值
        conn.execute(
            "INSERT INTO words (word, definition) VALUES ('w2', 'd')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, next_review_at) VALUES ('w3', 'd', 'learning', 1, 'garbage')",
            [],
        )
        .unwrap();

        let m011 = MIGRATIONS.iter().find(|m| m.version == 11).unwrap();
        conn.execute_batch(m011.sql).unwrap();

        let (utc_w1, utc_w2, raw_w3): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT MAX(CASE WHEN word='w1' THEN next_review_at END), \
                        MAX(CASE WHEN word='w2' THEN next_review_at END), \
                        MAX(CASE WHEN word='w3' THEN next_review_at END) FROM words",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        // w1：换算后的 UTC 应等于本地 now 减去当前时区偏移（容差 2 秒）
        let expected_utc = chrono::Utc::now();
        let parsed = chrono::NaiveDateTime::parse_from_str(&utc_w1.unwrap(), "%Y-%m-%d %H:%M:%S")
            .unwrap()
            .and_utc();
        assert!(
            (parsed - expected_utc).num_seconds().abs() <= 2,
            "转换结果应为 UTC 的 now：{parsed} vs {expected_utc}"
        );

        assert!(utc_w2.is_none(), "NULL 行不应被改动");
        assert_eq!(
            raw_w3.as_deref(),
            Some("garbage"),
            "非法格式的行应保守保留原值"
        );
    }

    // ── 013 迁移：去重 + lower(word) 唯一索引 ──

    #[test]
    fn migration_013_dedupe_keeps_deepest_progress_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 模拟已上线用户的库：应用 013 之前的全部迁移（无 UNIQUE 索引，允许重复行）
        for m in MIGRATIONS.iter().filter(|m| m.version < 13) {
            conn.execute_batch(m.sql).unwrap();
        }

        // 同词三行重复：进度最深的是 review_count=5/stability=8.0 的行（id 中间）
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, stability) VALUES ('hello', 'd', 'new', 0, 0.0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, stability) VALUES ('Hello', 'd', 'learning', 5, 8.0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count, stability) VALUES ('HELLO', 'd', 'new', 2, 0.0)",
            [],
        )
        .unwrap();
        // 无重复的词不受影响
        conn.execute(
            "INSERT INTO words (word, definition, review_status, review_count) VALUES ('world', 'd', 'learning', 3)",
            [],
        )
        .unwrap();

        // 同 review_count/stability 的重复行：平手时按 id ASC 保留最早行
        conn.execute(
            "INSERT INTO words (word, definition, review_count) VALUES ('twin', 'd', 1)",
            [],
        )
        .unwrap();
        let tie_early_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO words (word, definition, review_count) VALUES ('TWIN', 'd', 1)",
            [],
        )
        .unwrap();

        let m013 = MIGRATIONS.iter().find(|m| m.version == 13).unwrap();
        conn.execute_batch(m013.sql).unwrap();

        let survivors: Vec<(String, i64, i64)> = conn
            .prepare(
                "SELECT word, review_count, CAST(stability AS INTEGER) FROM words ORDER BY word",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(
            survivors,
            vec![
                ("Hello".to_string(), 5, 8),
                ("twin".to_string(), 1, 0),
                ("world".to_string(), 3, 0),
            ],
            "每组 lower(word) 应只保留进度最深的一行"
        );

        // 平手组幸存者应为最早插入的行
        let tie_survivor: i64 = conn
            .query_row(
                "SELECT id FROM words WHERE lower(word) = 'twin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tie_survivor, tie_early_id, "平手时应保留 id 最早的行");

        // 唯一索引已建：再次插入同词不同大小写应触发 UNIQUE 冲突
        let result = conn.execute(
            "INSERT INTO words (word, definition) VALUES ('twin', 'd')",
            [],
        );
        assert!(
            matches!(
                result,
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
            ),
            "013 应建立 lower(word) 唯一索引，重复插入被拒"
        );
    }

    // ── 迁移 checksum：记录、回填与 mismatch 容忍 ──

    #[test]
    fn migrations_record_checksums_on_apply() {
        let conn = create_test_db();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _migrations WHERE checksum IS NOT NULL AND LENGTH(checksum) = 16",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count,
            MIGRATIONS.len() as i64,
            "所有迁移都应记录 16 位十六进制 checksum"
        );
    }

    #[test]
    fn tampered_migration_sql_warns_but_does_not_block_startup() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).expect("首次迁移应成功");

        // 模拟迁移文件在应用后被修改：篡改 _migrations 中 version=1 的 recorded checksum，
        // 使其与当前 SQL 文本的哈希不匹配。run_migrations 只应告警，不报错。
        conn.execute(
            "UPDATE _migrations SET checksum = 'deadbeefdeadbeef' WHERE version = 1",
            [],
        )
        .unwrap();

        run_migrations(&mut conn).expect("checksum mismatch 不应阻塞启动");
        // 且不应重复执行迁移或破坏数据
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn legacy_migrations_get_checksum_backfilled() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        // 模拟旧版库：_migrations 无 checksum 列且已有历史记录
        conn.execute_batch("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))").unwrap();
        conn.execute(
            "INSERT INTO _migrations (version, description) VALUES (1, 'create_initial_tables')",
            [],
        )
        .unwrap();
        // 建出 words 表的最小结构，避免后续 UPDATE 报错
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();

        run_migrations(&mut conn).unwrap();

        let checksum: Option<String> = conn
            .query_row(
                "SELECT checksum FROM _migrations WHERE version = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            checksum.as_deref(),
            Some(sql_checksum(MIGRATIONS[0].sql).as_str()),
            "历史遗留的无 checksum 记录应按当前 SQL 回填"
        );
    }

    #[test]
    fn create_test_db_isolation() {
        // Two test DBs are independent — writes to one don't affect the other
        let conn1 = create_test_db();
        let conn2 = create_test_db();

        conn1
            .execute(
                "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value')",
                [],
            )
            .unwrap();

        // conn2 should not have the row
        let count: i64 = conn2
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'test_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "Test DBs should be isolated from each other");
    }

    // ── migrate_api_key_column：api_key 列 DEFAULT 重建（Keychain 不可用时的解毒） ──

    /// 构造遗留库：仅应用 001 + 002，models 表带 NOT NULL 无 DEFAULT 的 api_key
    /// 列与 002 追加的 created_at 列（后续迁移不应用，避免列被 migrate 掉）。
    fn legacy_models_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for m in MIGRATIONS.iter().filter(|m| m.version <= 2) {
            conn.execute_batch(m.sql).unwrap();
        }
        conn
    }

    /// 读 models 表全部列名（PRAGMA table_info 的列序即建表列序）。
    fn models_columns(conn: &rusqlite::Connection) -> Vec<String> {
        let mut stmt = conn.prepare("PRAGMA table_info(models)").unwrap();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    #[test]
    fn rebuild_models_heals_not_null_without_default() {
        let mut conn = legacy_models_conn();

        // 遗留行：明文 key（Keychain 迁移的原料）+ 默认模型标记 + created_at
        conn.execute(
            "INSERT INTO models (name, api_key, base_url, model_name, is_default, created_at) \
             VALUES ('legacy', 'sk-legacy', 'https://a.com', 'a', 1, '2024-01-01 00:00:00')",
            [],
        )
        .unwrap();
        let legacy_id = conn.last_insert_rowid();

        // 毒化状态复现：不带 api_key 的 INSERT 撞 NOT NULL（无 DEFAULT）——
        // 这正是 Keychain 不可用系统上 add_model 每次必败的原因
        let before = conn.execute(
            "INSERT INTO models (name, base_url, model_name) VALUES ('x', 'https://b.com', 'b')",
            [],
        );
        assert!(
            before.is_err(),
            "重建前 NOT NULL 无 DEFAULT 应拒绝不带 api_key 的 INSERT"
        );

        rebuild_models_with_api_key_default(&mut conn).unwrap();

        // 修复后：不带 api_key 的 INSERT 成功（落默认空串）
        conn.execute(
            "INSERT INTO models (name, base_url, model_name) VALUES ('x', 'https://b.com', 'b')",
            [],
        )
        .unwrap();
        let new_id = conn.last_insert_rowid();
        let new_api_key: String = conn
            .query_row(
                "SELECT api_key FROM models WHERE id = ?1",
                [new_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new_api_key, "", "缺省值应为空串");

        // 原有行数据全列保留（id/name/api_key/base_url/model_name/is_default/created_at）
        let row: (i64, String, String, String, String, i64, Option<String>) = conn
            .query_row(
                "SELECT id, name, api_key, base_url, model_name, is_default, created_at \
                 FROM models WHERE id = ?1",
                [legacy_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                legacy_id,
                "legacy".to_string(),
                "sk-legacy".to_string(),
                "https://a.com".to_string(),
                "a".to_string(),
                1,
                Some("2024-01-01 00:00:00".to_string()),
            ),
            "重建应全列保留原有行数据（遗留 key 留待下次启动重试迁移）"
        );

        // 列序与 001+002 预期一致（created_at 仍在末尾）
        assert_eq!(
            models_columns(&conn),
            EXPECTED_MODELS_COLUMNS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            "重建后列序应与 001+002 一致"
        );
    }

    #[test]
    fn rebuild_models_is_idempotent_via_default_guard() {
        let mut conn = legacy_models_conn();
        assert_eq!(
            api_key_default_value(&conn).unwrap(),
            None,
            "遗留表 api_key 无默认值"
        );

        rebuild_models_with_api_key_default(&mut conn).unwrap();
        assert_eq!(
            api_key_default_value(&conn).unwrap().as_deref(),
            Some("''"),
            "重建后 api_key 默认值应为空串"
        );

        // 守卫命中：再次调用不重建。以 rootpage 不变证明没有发生 DROP/RENAME
        // （重建会建新表、分配新 rootpage）。
        let rootpage_before: i64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'models'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        rebuild_models_with_api_key_default(&mut conn).unwrap();
        let rootpage_after: i64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'models'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            rootpage_before, rootpage_after,
            "已有默认值时应短路，不重复重建"
        );
    }

    #[test]
    fn rebuild_models_skips_when_columns_drifted() {
        let mut conn = legacy_models_conn();
        // 模拟未来迁移给 models 加了列：按硬编码 schema 重建会静默丢该列，
        // 函数应拒绝重建并保留原状（毒化状态留待更新 EXPECTED_MODELS_COLUMNS 后再修）
        conn.execute_batch("ALTER TABLE models ADD COLUMN extra_col INTEGER")
            .unwrap();

        rebuild_models_with_api_key_default(&mut conn).unwrap();

        assert!(
            models_columns(&conn).contains(&"extra_col".to_string()),
            "列集漂移时应拒绝重建，保留原列"
        );
        assert_eq!(
            api_key_default_value(&conn).unwrap(),
            None,
            "拒绝重建后 api_key 仍无默认值"
        );
    }

    #[test]
    fn rebuild_models_restores_indexes() {
        let mut conn = legacy_models_conn();
        conn.execute_batch("CREATE INDEX idx_models_name ON models(name)")
            .unwrap();

        rebuild_models_with_api_key_default(&mut conn).unwrap();

        let idx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'index' AND name = 'idx_models_name'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 1, "models 上的索引应在重建后复原");
    }

    #[test]
    fn migrate_api_key_column_drops_column_when_no_legacy_keys() {
        let mut conn = legacy_models_conn();
        // 空 models 表：无 key 需要迁移，不触达 OS Keychain
        migrate_api_key_column(&mut conn).unwrap();
        assert!(
            !models_columns(&conn).iter().any(|c| c == "api_key"),
            "无遗留 key 时列应被删除"
        );
    }
}
