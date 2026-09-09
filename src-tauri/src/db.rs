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
/// - 如果存在旧的 `api_key` 列（来自 tauri-plugin-sql 版本），将其迁移到 OS Keychain 并删除。
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
    // 失败不再阻塞启动（降级策略见 migrate_api_key_column 文档）。
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
/// 幂等性：入口处用 PRAGMA table_info 短路——列不存在（含已迁移完成、全新库）
/// 时直接返回 Ok，不产生任何写入。因此每次启动重复调用是安全的。
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

        // Should have all 13 migrations applied
        assert_eq!(
            versions,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
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
}
