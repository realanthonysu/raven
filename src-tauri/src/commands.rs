/// Tauri Command 处理器 —— 前端通过 invoke() 调用这些函数。
///
/// 替代原来的 db.ts 直接 SQL 操作，所有数据库访问都通过 Rust 命令完成。
/// 命名约定：Rust 侧 snake_case，前端 invoke 时自动转 camelCase。
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::credentials;
use crate::db::Db;

/// Extension trait to log row-level errors instead of silently discarding them.
trait RowResultIterExt: Iterator<Item = Result<Self::Ok, rusqlite::Error>> + Sized {
    type Ok;
    fn log_errors(self) -> impl Iterator<Item = Self::Ok> {
        self.filter_map(|r| match r {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[db] row deserialization error: {e}");
                None
            }
        })
    }
}

impl<T, I: Iterator<Item = Result<T, rusqlite::Error>>> RowResultIterExt for I {
    type Ok = T;
}

// ============================================================================
// 数据传输对象（DTO）
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelDto {
    pub id: i64,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

#[derive(Debug, Deserialize)]
pub struct NewModelInput {
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WordDto {
    pub id: i64,
    pub word: String,
    pub phonetic: Option<String>,
    pub definition: String,
    pub level: Option<String>,
    pub source_type: Option<String>,
    pub source_text: Option<String>,
    pub notes: Option<String>,
    pub review_status: String,
    pub review_count: Option<i64>,
    pub next_review_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryDto {
    pub id: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub input_text: String,
    pub result: String,
    pub graph_data: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewStatsDto {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub mastered_count: i64,
    pub due_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StreakRowDto {
    pub date: String,
    pub activities: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GoalDto {
    pub goal_type: String,
    pub target: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TtsConfigDto {
    pub base_url: String,
    pub api_key: String,
    pub voice: String,
    pub speed: f64,
}

// ============================================================================
// 辅助宏：简化 DB 锁定 + 错误转换
// ============================================================================

macro_rules! with_db {
    ($db:expr, $body:expr) => {{
        let conn = $db.0.lock().map_err(|e| format!("DB lock error: {e}"))?;
        (|| -> Result<_, String> { $body(&conn) })()
    }};
}

// ============================================================================
// 模型配置（Phase 1: OS Keychain 集成）
// ============================================================================

#[tauri::command]
pub async fn get_models(db: State<'_, Db>) -> Result<Vec<ModelDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT id, name, base_url, model_name, is_default FROM models ORDER BY is_default DESC")
            .map_err(|e| e.to_string())?;
        let models: Vec<ModelDto> = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                Ok((
                    id,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .map(|(id, name, base_url, model_name, is_default)| {
                let api_key = credentials::get_key(id).ok().flatten().unwrap_or_default();
                ModelDto { id, name, api_key, base_url, model_name, is_default }
            })
            .collect();
        Ok(models)
    })
}

#[tauri::command]
pub async fn add_model(db: State<'_, Db>, model: NewModelInput) -> Result<i64, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        // 插入模型（不带 api_key，它存在 Keychain 里）
        conn.execute(
            "INSERT INTO models (name, base_url, model_name, is_default) VALUES (?1, ?2, ?3, 0)",
            params![model.name, model.base_url, model.model_name],
        ).map_err(|e| e.to_string())?;

        let new_id = conn.last_insert_rowid();

        // 存储 API Key 到 OS Keychain
        if !model.api_key.is_empty() {
            credentials::store_key(new_id, &model.api_key)?;
        }

        // 如果标记为默认，更新 is_default
        if model.is_default {
            conn.execute(
                "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                params![new_id],
            ).map_err(|e| e.to_string())?;
        }

        Ok(new_id)
    })
}

#[tauri::command]
pub async fn delete_model(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM models WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        // 同时删除 Keychain 中的 API Key
        credentials::delete_key(id).ok();
        Ok(())
    })
}

#[tauri::command]
pub async fn get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        // 优先获取 is_default=1 的模型
        let mut stmt = conn
            .prepare("SELECT id, name, base_url, model_name, is_default FROM models WHERE is_default = 1 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();

        if let Some((id, name, base_url, model_name, is_default)) = result {
            let api_key = credentials::get_key(id).ok().flatten().unwrap_or_default();
            return Ok(Some(ModelDto { id, name, api_key, base_url, model_name, is_default }));
        }

        // 回退：返回 id 最小的模型
        let mut stmt = conn
            .prepare("SELECT id, name, base_url, model_name, is_default FROM models ORDER BY id ASC LIMIT 1")
            .map_err(|e| e.to_string())?;
        let fallback = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();

        Ok(fallback.map(|(id, name, base_url, model_name, is_default)| {
            let api_key = credentials::get_key(id).ok().flatten().unwrap_or_default();
            ModelDto { id, name, api_key, base_url, model_name, is_default }
        }))
    })
}

#[tauri::command]
pub async fn set_default_model(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// 生词本
// ============================================================================

#[tauri::command]
pub async fn db_add_word(
    db: State<'_, Db>,
    word: String, phonetic: Option<String>, definition: String,
    level: Option<String>, source_type: Option<String>, source_text: Option<String>,
    notes: Option<String>, review_status: Option<String>,
) -> Result<i64, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO words (word, phonetic, definition, level, source_type, source_text, notes, review_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![word, phonetic, definition, level, source_type, source_text, notes, review_status.unwrap_or_else(|| "new".into())],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command]
pub async fn db_get_words(db: State<'_, Db>) -> Result<Vec<WordDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at FROM words ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let words = stmt.query_map([], row_to_word).map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(words)
    })
}

#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM words WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_word_level(db: State<'_, Db>, id: i64, level: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("UPDATE words SET level = ?1 WHERE id = ?2", params![level, id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_word_enrichment(
    db: State<'_, Db>, id: i64, phonetic: String, definition: String, notes: String,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET phonetic = ?1, definition = ?2, notes = ?3 WHERE id = ?4",
            params![phonetic, definition, notes, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_get_review_stats(db: State<'_, Db>) -> Result<ReviewStatsDto, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let row = conn.query_row(
            "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN review_status = 'new' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status = 'learning' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status = 'mastered' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN review_status = 'new' OR next_review_at IS NULL OR next_review_at <= datetime('now') THEN 1 ELSE 0 END), 0) FROM words",
            [],
            |row| Ok(ReviewStatsDto {
                total: row.get(0)?, new_count: row.get(1)?, learning_count: row.get(2)?,
                mastered_count: row.get(3)?, due_count: row.get(4)?,
            }),
        ).map_err(|e| e.to_string())?;
        Ok(row)
    })
}

#[tauri::command]
pub async fn db_get_review_words(db: State<'_, Db>, limit: i64) -> Result<Vec<WordDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let words = stmt.query_map(params![limit], row_to_word).map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(words)
    })
}

#[tauri::command]
pub async fn db_update_word_review(
    db: State<'_, Db>, id: i64, status: String, review_count: i64, next_review_at: Option<String>,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET review_status = ?1, review_count = ?2, next_review_at = ?3 WHERE id = ?4",
            params![status, review_count, next_review_at, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

fn row_to_word(row: &rusqlite::Row) -> rusqlite::Result<WordDto> {
    Ok(WordDto {
        id: row.get(0)?, word: row.get(1)?, phonetic: row.get(2)?,
        definition: row.get(3)?, level: row.get(4)?, source_type: row.get(5)?,
        source_text: row.get(6)?, notes: row.get(7)?, review_status: row.get(8)?,
        review_count: row.get(9)?, next_review_at: row.get(10)?, created_at: row.get(11)?,
    })
}

// ============================================================================
// 历史记录
// ============================================================================

#[tauri::command]
pub async fn db_add_history(
    db: State<'_, Db>, record_type: String, input_text: String, result: String,
    graph_data: Option<String>,
) -> Result<i64, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO history (type, input_text, result, graph_data) VALUES (?1, ?2, ?3, ?4)",
            params![record_type, input_text, result, graph_data],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command]
pub async fn db_get_history(
    db: State<'_, Db>, record_type: Option<String>, limit: Option<i64>, offset: Option<i64>,
) -> Result<Vec<HistoryDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        // Use unified query with LIMIT -1 (no limit) and OFFSET 0 as defaults
        let effective_limit = limit.unwrap_or(-1);
        let effective_offset = offset.unwrap_or(0);

        let (sql, param_vals): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(ref rt) = record_type {
            (
                "SELECT id, type, input_text, result, graph_data, created_at FROM history WHERE type = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3".into(),
                vec![Box::new(rt.clone()), Box::new(effective_limit), Box::new(effective_offset)],
            )
        } else {
            (
                "SELECT id, type, input_text, result, graph_data, created_at FROM history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2".into(),
                vec![Box::new(effective_limit), Box::new(effective_offset)],
            )
        };
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_vals.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let records = stmt.query_map(params_refs.as_slice(), row_to_history).map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(records)
    })
}

#[tauri::command]
pub async fn db_get_history_by_id(db: State<'_, Db>, id: i64) -> Result<Option<HistoryDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT id, type, input_text, result, graph_data, created_at FROM history WHERE id = ?1 LIMIT 1"
        ).map_err(|e| e.to_string())?;
        let record = stmt.query_map(params![id], row_to_history).map_err(|e| e.to_string())?
            .log_errors().next();
        Ok(record)
    })
}

#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM history WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_history_graph_data(db: State<'_, Db>, id: i64, graph_data: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("UPDATE history SET graph_data = ?1 WHERE id = ?2", params![graph_data, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// 查询最近的纠错记录，供前端 buildPersonalizedContext 使用。
#[tauri::command]
pub async fn db_get_recent_correct_results(db: State<'_, Db>, max_records: i64) -> Result<Vec<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT result FROM history WHERE type = 'correct' ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let results = stmt.query_map(params![max_records], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(results)
    })
}

fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryDto> {
    Ok(HistoryDto {
        id: row.get(0)?, record_type: row.get(1)?, input_text: row.get(2)?,
        result: row.get(3)?, graph_data: row.get(4)?, created_at: row.get(5)?,
    })
}

// ============================================================================
// 设置（Key-Value）
// ============================================================================

#[tauri::command]
pub async fn db_get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;
        let val = stmt.query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors().next();
        Ok(val)
    })
}

#[tauri::command]
pub async fn db_set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// 学习连续打卡
// ============================================================================

#[tauri::command]
pub async fn db_record_learning_activity(db: State<'_, Db>, date: String, activity: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO learning_streaks (date, activities) VALUES (?1, json_set('{}', '$.' || ?2, 1)) ON CONFLICT(date) DO UPDATE SET activities = json_set(COALESCE(activities, '{}'), '$.' || ?2, COALESCE(json_extract(activities, '$.' || ?2), 0) + 1)",
            params![date, activity],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_get_all_streaks(db: State<'_, Db>) -> Result<Vec<StreakRowDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare("SELECT date, activities FROM learning_streaks ORDER BY date DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(StreakRowDto { date: row.get(0)?, activities: row.get(1)? }))
            .map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(rows)
    })
}

#[tauri::command]
pub async fn db_get_today_activities(db: State<'_, Db>, date: String) -> Result<Option<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare("SELECT activities FROM learning_streaks WHERE date = ?1")
            .map_err(|e| e.to_string())?;
        let val = stmt.query_map(params![date], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors().next();
        Ok(val)
    })
}

// ============================================================================
// 学习目标
// ============================================================================

#[tauri::command]
pub async fn db_get_learning_goals(db: State<'_, Db>) -> Result<Vec<GoalDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare("SELECT goal_type, target FROM learning_goals")
            .map_err(|e| e.to_string())?;
        let goals = stmt.query_map([], |row| Ok(GoalDto { goal_type: row.get(0)?, target: row.get(1)? }))
            .map_err(|e| e.to_string())?
            .log_errors().collect();
        Ok(goals)
    })
}

#[tauri::command]
pub async fn db_set_learning_goal(db: State<'_, Db>, goal_type: String, target: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO learning_goals (goal_type, target) VALUES (?1, ?2) ON CONFLICT(goal_type) DO UPDATE SET target = ?2",
            params![goal_type, target],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// TTS 配置（API Key 存 Keychain，其他存 settings）
// ============================================================================

#[tauri::command]
pub async fn db_get_tts_config(db: State<'_, Db>) -> Result<TtsConfigDto, String> {
    // 从 settings 读取非敏感配置
    let (base_url, voice, speed_str) = with_db!(db, |conn: &rusqlite::Connection| {
        let get = |key: &str| -> Result<String, String> {
            let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1 LIMIT 1")
                .map_err(|e| e.to_string())?;
            let val = stmt.query_map(params![key], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .log_errors().next().unwrap_or_default();
            Ok(val)
        };
        Ok((get("tts_base_url")?, get("tts_voice")?, get("tts_speed")?))
    })?;

    // 从 Keychain 读取 API Key
    let api_key = credentials::get_tts_key().ok().flatten().unwrap_or_default();

    Ok(TtsConfigDto {
        base_url: if base_url.is_empty() { "https://api.openai.com/v1".into() } else { base_url },
        api_key,
        voice: if voice.is_empty() { "alloy".into() } else { voice },
        speed: speed_str.parse::<f64>().unwrap_or(1.0),
    })
}

#[tauri::command]
pub async fn db_set_tts_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    if key == "tts_api_key" {
        // API Key 存 Keychain，不存数据库
        credentials::store_tts_key(&value)?;
    } else {
        with_db!(db, |conn: &rusqlite::Connection| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, value],
            ).map_err(|e| e.to_string())?;
            Ok(())
        })?;
    }
    Ok(())
}

// ============================================================================
// 间隔重复算法（Phase 3: 算法下沉到 Rust）
// ============================================================================

/// 间隔重复算法的输入参数。
#[derive(Debug, Deserialize)]
pub struct ReviewCalcInput {
    pub review_status: String,
    pub review_count: i64,
    pub next_review_at: Option<String>,
    pub rating: String, // "again" | "hard" | "good"
}

/// 间隔重复算法的输出结果。
#[derive(Debug, Serialize)]
pub struct ReviewCalcResult {
    pub status: String,
    pub interval: i64,
    pub next_review_at: String,
}

/// 根据用户自评计算下次复习参数（间隔重复算法）。
///
/// 算法逻辑：
/// - "again"（不认识）→ 间隔重置为 1 天，状态设为 learning
/// - "hard"（模糊）→ 间隔不变
/// - "good"（认识）→ 间隔翻倍（最多 30 天）
///   - review_count >= 3 且 rating="good" → 晋升为 mastered
#[tauri::command]
pub async fn calculate_next_review(input: ReviewCalcInput) -> Result<ReviewCalcResult, String> {
    // 计算当前间隔：从现在到 next_review_at 的天数，最小 1 天
    let current_interval: i64 = if let Some(ref nra) = input.next_review_at {
        let now = chrono::Utc::now();
        match chrono::DateTime::parse_from_rfc3339(nra)
            .or_else(|_| chrono::NaiveDateTime::parse_from_str(nra, "%Y-%m-%d %H:%M:%S").map(|n| n.and_utc().fixed_offset()))
        {
            Ok(dt) => {
                let diff_days = (dt.with_timezone(&chrono::Utc) - now).num_days();
                std::cmp::max(1, diff_days)
            }
            Err(_) => 1,
        }
    } else {
        1
    };

    // 根据自评确定新间隔
    let new_interval: i64 = match input.rating.as_str() {
        "again" => 1,
        "hard" => current_interval,
        _ => std::cmp::max(std::cmp::min(current_interval * 2, 30), 2), // good: 翻倍，上限 30
    };

    // 确定新的复习状态
    let status = if input.rating == "again" {
        "learning".to_string()
    } else if input.rating == "good" && input.review_count >= 3 {
        "mastered".to_string()
    } else if input.review_status == "new" {
        "learning".to_string()
    } else {
        input.review_status.clone()
    };

    let next_review_at = (chrono::Utc::now() + chrono::Duration::days(new_interval))
        .to_rfc3339();

    Ok(ReviewCalcResult {
        status,
        interval: new_interval,
        next_review_at,
    })
}

// ============================================================================
// 导出功能（Phase 3: CSV / Anki / 数据库备份）
// ============================================================================

/// 导出所有生词为 CSV 格式。
/// 返回 CSV 字符串，前端通过 Tauri 的文件对话框保存。
#[tauri::command]
pub async fn export_words_csv(db: State<'_, Db>) -> Result<String, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT word, phonetic, definition, level, source_type, notes, review_status, review_count, next_review_at, created_at FROM words ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;

        let mut csv = String::from("word,phonetic,definition,level,source_type,notes,review_status,review_count,next_review_at,created_at\n");

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
            ))
        }).map_err(|e| e.to_string())?;

        for row in rows {
            if let Ok((word, phonetic, definition, level, source_type, notes, status, count, nra, created)) = row {
                let escape = |s: &str| -> String {
                    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
                        format!("\"{}\"" , s.replace('"', "\"\""))
                    } else {
                        s.to_string()
                    }
                };
                let opt = |o: &Option<String>| -> String {
                    o.as_deref().map(|s| escape(s)).unwrap_or_default()
                };
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{},{}\n",
                    escape(&word),
                    opt(&phonetic),
                    escape(&definition),
                    opt(&level),
                    opt(&source_type),
                    opt(&notes),
                    escape(&status),
                    count.unwrap_or(0),
                    opt(&nra),
                    escape(&created),
                ));
            }
        }
        Ok(csv)
    })
}

/// 导出所有生词为 Anki 导入格式（Tab 分隔）。
/// Anki 字段：Front（单词）\t Back（音标 + 释义 + 搭配/例句）
#[tauri::command]
pub async fn export_words_anki(db: State<'_, Db>) -> Result<String, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT word, phonetic, definition, notes FROM words ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;

        let mut output = String::new();
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        }).map_err(|e| e.to_string())?;

        for row in rows {
            if let Ok((word, phonetic, definition, notes)) = row {
                let phonetic_str = phonetic.as_deref().unwrap_or("");
                let notes_str = notes.as_deref().unwrap_or("");
                // Anki format: Front\tBack\n
                output.push_str(&format!(
                    "{}\t{} <br> {} <br> {}\n",
                    word, phonetic_str, definition, notes_str
                ));
            }
        }
        Ok(output)
    })
}

/// 备份数据库文件到指定路径。
/// 使用 SQLite 的 backup API 确保一致性（不会备份到写入中途的不完整状态）。
/// 备份前执行 WAL checkpoint 确保所有数据已写入主文件。
#[tauri::command]
pub async fn backup_db(db: State<'_, Db>, dest_path: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        // Checkpoint WAL to ensure all data is in the main database file
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
        let mut dest = rusqlite::Connection::open(&dest_path)
            .map_err(|e| format!("Failed to open backup destination: {e}"))?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dest)
            .map_err(|e| format!("Backup init failed: {e}"))?;
        backup.run_to_completion(100, std::time::Duration::from_millis(10), None)
            .map_err(|e| format!("Backup failed: {e}"))?;
        Ok(())
    })
}
