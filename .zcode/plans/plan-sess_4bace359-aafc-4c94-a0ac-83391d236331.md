
# Command 层迁移到 Repository Trait 方法调用

## 设计原则

**核心模式**：每个 Command 文件中提取 `_core` 函数，接受 `&impl ReadRepository` 或 `&mut impl WriteRepository`。Tauri handler 通过宏获取连接后委托给 `_core` 函数。测试中用 mock 替代真实 DB。

```rust
// ── 核心逻辑（可测试） ──
fn resolve_default_model(repo: &impl ReadRepository) -> Result<Option<ModelDto>, AppError> {
    if let Some(m) = repo.get_default_model()? { return Ok(Some(m)); }
    repo.get_first_model()
}

// ── Tauri handler（薄委托） ──
#[tauri::command]
pub async fn db_get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, AppError> {
    with_db_read!(db, |conn| resolve_default_model(conn))
}
```

## 迁移范围

### Tier 1 — 提取有业务逻辑的 core 函数（6 个 command）

| Command | Core 函数 | 测试要点 |
|---------|----------|---------|
| `db_get_default_model` | `resolve_default_model(repo)` | fallback 链：default → first |
| `db_get_tts_config` | `build_tts_config(repo, get_tts_key)` | DB + Keychain + 默认值 + speed 解析 |
| `db_set_setting` | `validate_setting_key(key)` + trait call | 白名单拒绝非法 key |
| `db_set_tts_setting` | `handle_set_tts_setting(repo, store_key, delete_key, key, value)` | Keychain 路由 vs DB 路由 |
| `db_get_history` / `db_get_history_list` | `query_history_typed(repo, types, limit, offset)` | Vec\<String\> → Vec\<&str\> 转换 |
| `db_write_text_file` | `validate_write_path(path)` | 路径安全校验（白名单目录） |

### Tier 2 — 机械迁移到 trait 调用（27 个 command）

所有 thin wrapper 命令统一改为 `with_db!(db, |conn| conn.method_name(args))` 形式。不提取独立 core 函数（逻辑已在 repository 层可测）。

## 文件变更

### `src-tauri/src/commands/models.rs`
- 提取 `resolve_default_model(repo: &impl ReadRepository)`
- 6 个 handler 改为 trait 调用
- 添加 `#[cfg(test)] mod tests` 覆盖 fallback 链

### `src-tauri/src/commands/settings.rs`
- 提取 `build_tts_config(repo, get_tts_key)` 和 `validate_setting_key(key)`
- 提取 `handle_set_tts_setting(repo, store_key, delete_key, key, value)`
- 4 个 handler 改为 trait 调用
- 添加测试覆盖白名单、TTS 默认值、Keychain 路由

### `src-tauri/src/commands/history.rs`
- 提取 `query_history_typed(repo, types, limit, offset)` 处理字符串转换
- 7 个 handler 改为 trait 调用

### `src-tauri/src/commands/export.rs`
- 提取 `validate_write_path(path) -> Result<PathBuf, AppError>`
- 4 个 handler 改为 trait 调用（db_backup_db 保留 spawn_blocking 包装）
- 添加路径安全测试

### `src-tauri/src/commands/words.rs`, `learning.rs`, `fsrs.rs`
- 所有 handler 改为 trait 调用（`conn.method_name(args)`）
- 无 core 函数提取（thin wrapper）

### `src-tauri/src/repository/traits.rs`
- 移除 `#[allow(dead_code)]`（trait 现在被使用）

## Mock 基础设施

在 `commands/shared.rs` 中添加测试用 mock：

```rust
#[cfg(test)]
pub(crate) mod test_mocks {
    use super::*;
    use crate::repository::traits::{ReadRepository, WriteRepository};

    /// 只读 mock：预设返回值，用于测试 ReadRepository 依赖的 core 函数
    pub(crate) struct MockReadRepo {
        pub models: Vec<ModelDto>,
        pub default_model: Option<ModelDto>,
        pub first_model: Option<ModelDto>,
        // ... 其他预设值
    }

    /// 写 mock：可配置写操作成败，用于测试 WriteRepository 依赖的 core 函数
    pub(crate) struct MockWriteRepo {
        pub read: MockReadRepo,
        pub write_succeeds: bool,
    }
}
```

## 验证
- `cargo check` — 零警告
- `cargo test` — 所有现有测试 + 新增 core 函数测试通过
- `npx tsc --noEmit` — 前端不受影响（Rust-only 变更）
