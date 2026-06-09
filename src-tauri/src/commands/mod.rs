/// Tauri Command handlers - frontend invokes these via invoke().
///
/// Naming convention: Rust-side snake_case, frontend invoke() auto-converts to camelCase.
mod shared;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::credentials;
use crate::db::Db;

use shared::{
    row_to_history, row_to_word, with_db, GoalDto, HistoryDto, LearningActivity, ModelDto,
    NewModelInput, ReviewStatsDto, RowResultIterExt, StreakRowDto, TtsConfigDto, WordDto,
};

// ============================================================================
// Model CRUD (OS Keychain integration)
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
                ModelDto {
                    id,
                    name,
                    api_key,
                    base_url,
                    model_name,
                    is_default,
                }
            })
            .collect();
        Ok(models)
    })
}

#[tauri::command]
pub async fn add_model(db: State<'_, Db>, model: NewModelInput) -> Result<i64, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO models (name, base_url, model_name, is_default) VALUES (?1, ?2, ?3, 0)",
            params![model.name, model.base_url, model.model_name],
        )
        .map_err(|e| e.to_string())?;

        let new_id = conn.last_insert_rowid();

        if !model.api_key.is_empty() {
            credentials::store_key(new_id, &model.api_key).map_err(|e| e.to_string())?;
        }

        if model.is_default {
            conn.execute(
                "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                params![new_id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(new_id)
    })
}

#[tauri::command]
pub async fn delete_model(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM models WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        credentials::delete_key(id).ok();
        Ok(())
    })
}

#[tauri::command]
pub async fn get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT id, name, base_url, model_name, is_default FROM models WHERE is_default = 1 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();

        if let Some((id, name, base_url, model_name, is_default)) = result {
            let api_key = credentials::get_key(id).ok().flatten().unwrap_or_default();
            return Ok(Some(ModelDto {
                id,
                name,
                api_key,
                base_url,
                model_name,
                is_default,
            }));
        }

        // Fallback: return the model with the lowest id
        let mut stmt = conn
            .prepare("SELECT id, name, base_url, model_name, is_default FROM models ORDER BY id ASC LIMIT 1")
            .map_err(|e| e.to_string())?;
        let fallback = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();

        Ok(
            fallback.map(|(id, name, base_url, model_name, is_default)| {
                let api_key = credentials::get_key(id).ok().flatten().unwrap_or_default();
                ModelDto {
                    id,
                    name,
                    api_key,
                    base_url,
                    model_name,
                    is_default,
                }
            }),
        )
    })
}

#[tauri::command]
pub async fn set_default_model(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE models SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// Word CRUD and review
// ============================================================================

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_add_word(
    db: State<'_, Db>,
    word: String,
    phonetic: Option<String>,
    definition: String,
    level: Option<String>,
    source_type: Option<String>,
    source_text: Option<String>,
    notes: Option<String>,
    review_status: Option<String>,
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
            "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let words = stmt
            .query_map([], row_to_word)
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect();
        Ok(words)
    })
}

#[tauri::command]
pub async fn db_delete_word(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM words WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_word_level(db: State<'_, Db>, id: i64, level: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET level = ?1 WHERE id = ?2",
            params![level, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_word_enrichment(
    db: State<'_, Db>,
    id: i64,
    phonetic: String,
    definition: String,
    notes: String,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET phonetic = ?1, definition = ?2, notes = ?3 WHERE id = ?4",
            params![phonetic, definition, notes, id],
        )
        .map_err(|e| e.to_string())?;
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
            "SELECT id, word, phonetic, definition, level, source_type, source_text, notes, review_status, review_count, next_review_at, created_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state FROM words WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now')) ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let words = stmt
            .query_map(params![limit], row_to_word)
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect();
        Ok(words)
    })
}

#[tauri::command]
pub async fn db_update_word_review(
    db: State<'_, Db>,
    id: i64,
    status: String,
    review_count: i64,
    next_review_at: Option<String>,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET review_status = ?1, review_count = ?2, next_review_at = ?3 WHERE id = ?4",
            params![status, review_count, next_review_at, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// History CRUD
// ============================================================================

#[tauri::command]
pub async fn db_add_history(
    db: State<'_, Db>,
    record_type: String,
    input_text: String,
    result: String,
    graph_data: Option<String>,
) -> Result<i64, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO history (type, input_text, result, graph_data) VALUES (?1, ?2, ?3, ?4)",
            params![record_type, input_text, result, graph_data],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command]
pub async fn db_get_history(
    db: State<'_, Db>,
    record_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HistoryDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let effective_limit = limit.unwrap_or(-1);
        let effective_offset = offset.unwrap_or(0);

        let mut stmt = if record_type.is_some() {
            conn.prepare(
                "SELECT id, type, input_text, result, graph_data, created_at FROM history WHERE type = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
            ).map_err(|e| e.to_string())?
        } else {
            conn.prepare(
                "SELECT id, type, input_text, result, graph_data, created_at FROM history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            ).map_err(|e| e.to_string())?
        };

        let records: Vec<HistoryDto> = if let Some(ref rt) = record_type {
            stmt.query_map(
                params![rt.as_str(), effective_limit, effective_offset],
                row_to_history,
            )
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect()
        } else {
            stmt.query_map(params![effective_limit, effective_offset], row_to_history)
                .map_err(|e| e.to_string())?
                .log_errors()
                .collect()
        };
        Ok(records)
    })
}

#[tauri::command]
pub async fn db_get_history_by_id(
    db: State<'_, Db>,
    id: i64,
) -> Result<Option<HistoryDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT id, type, input_text, result, graph_data, created_at FROM history WHERE id = ?1 LIMIT 1"
        ).map_err(|e| e.to_string())?;
        let record = stmt
            .query_map(params![id], row_to_history)
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();
        Ok(record)
    })
}

#[tauri::command]
pub async fn db_delete_history(db: State<'_, Db>, id: i64) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute("DELETE FROM history WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_update_history_graph_data(
    db: State<'_, Db>,
    id: i64,
    graph_data: String,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE history SET graph_data = ?1 WHERE id = ?2",
            params![graph_data, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Query recent correction records for the frontend's buildPersonalizedContext.
#[tauri::command]
pub async fn db_get_recent_correct_results(
    db: State<'_, Db>,
    max_records: i64,
) -> Result<Vec<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT result FROM history WHERE type = 'correct' ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let results = stmt
            .query_map(params![max_records], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect();
        Ok(results)
    })
}

// ============================================================================
// Settings and TTS configuration
// ============================================================================

#[tauri::command]
pub async fn db_get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;
        let val = stmt
            .query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();
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

#[tauri::command]
pub async fn db_get_tts_config(db: State<'_, Db>) -> Result<TtsConfigDto, String> {
    let (base_url, voice, speed_str) = with_db!(db, |conn: &rusqlite::Connection| {
        let get = |key: &str| -> Result<String, String> {
            let mut stmt = conn
                .prepare("SELECT value FROM settings WHERE key = ?1 LIMIT 1")
                .map_err(|e| e.to_string())?;
            let val = stmt
                .query_map(params![key], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .log_errors()
                .next()
                .unwrap_or_default();
            Ok(val)
        };
        Ok((get("tts_base_url")?, get("tts_voice")?, get("tts_speed")?))
    })?;

    let api_key = credentials::get_tts_key()
        .ok()
        .flatten()
        .unwrap_or_default();

    Ok(TtsConfigDto {
        base_url: if base_url.is_empty() {
            "https://api.openai.com/v1".into()
        } else {
            base_url
        },
        api_key,
        voice: if voice.is_empty() {
            "alloy".into()
        } else {
            voice
        },
        speed: speed_str.parse::<f64>().unwrap_or(1.0),
    })
}

#[tauri::command]
pub async fn db_set_tts_setting(
    db: State<'_, Db>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key == "tts_api_key" {
        credentials::store_tts_key(&value).map_err(|e| e.to_string())?;
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
// FSRS (Free Spaced Repetition Scheduler)
// ============================================================================

/// Initial stability for each rating (index 1=Again, 2=Hard, 3=Good, 4=Easy).
const FSRS_STABILITY_INIT: [f64; 5] = [0.0, 0.3, 0.8, 3.0, 5.0];

/// Initial difficulty for each rating (1=Again, 4=Easy).
const FSRS_DIFFICULTY_INIT: [f64; 5] = [0.0, 8.0, 6.0, 4.0, 2.0];

/// Target retention rate (probability of recall at review time).
const FSRS_REQUEST_RETENTION: f64 = 0.9;

/// Difficulty change per rating relative to Good (3).
const FSRS_DIFFICULTY_WEIGHTS: [f64; 5] = [0.0, 0.2, 0.1, 0.0, -0.1];

/// Maximum stability cap (10 years) to prevent overflow.
const FSRS_MAXIMUM_INTERVAL: f64 = 3650.0;

/// FSRS rating values. Deserialization accepts lowercase strings.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FsrsRating {
    Again, // 1
    Hard,  // 2
    Good,  // 3
    Easy,  // 4
}

impl FsrsRating {
    fn value(self) -> u8 {
        match self {
            Self::Again => 1,
            Self::Hard => 2,
            Self::Good => 3,
            Self::Easy => 4,
        }
    }
    fn index(self) -> usize {
        self.value() as usize
    }
}

/// FSRS state for a single card (word).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsrsCard {
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub state: i64, // 0=new, 1=learning, 2=review, 3=relearning
}

impl FsrsCard {
    fn review(self, rating: FsrsRating) -> Self {
        let mut card = self;
        let r = rating.index();
        let elapsed = card.elapsed_days as f64;

        // First review (state == new, stability == 0)
        if card.state == 0 {
            let initial_stability = FSRS_STABILITY_INIT[r];
            let initial_difficulty = FSRS_DIFFICULTY_INIT[r];
            let next_interval = Self::next_interval(initial_stability);

            return Self {
                stability: initial_stability,
                difficulty: initial_difficulty,
                elapsed_days: 0,
                scheduled_days: next_interval as i64,
                reps: 1,
                lapses: if rating.value() == 1 { 1 } else { 0 },
                state: if rating.value() == 1 { 1 } else { 2 },
            };
        }

        card.reps += 1;

        let d_delta = FSRS_DIFFICULTY_WEIGHTS[r] * (rating.value() as f64 - 3.0);
        let new_difficulty = (card.difficulty + d_delta).clamp(1.0, 10.0);

        let r_val = if card.stability > 0.0 {
            (1.0 + elapsed / (9.0 * card.stability)).powf(-1.0)
        } else {
            0.0
        };

        let exp_component = (-0.1 * (card.reps as f64 - 1.0)).exp();
        let d_factor = (10.0 - new_difficulty) / 9.0;

        let stabilizer = match rating {
            FsrsRating::Again => 0.0,
            FsrsRating::Hard => d_factor * 1.3_f64.powf(-(new_difficulty / 10.0)) * exp_component,
            FsrsRating::Good => {
                d_factor * (11.0 - new_difficulty) / 10.0
                    * (1.0_f64 - r_val)
                    * exp_component
                    * if r_val < 0.5 { 1.2 } else { 1.0 }
            }
            FsrsRating::Easy => {
                d_factor * (11.0 - new_difficulty) / 10.0 * (1.0_f64 - r_val) * exp_component * 2.5
            }
        };

        let new_stability = match rating {
            FsrsRating::Again => {
                let w_penalty = (new_difficulty / 10.0 * 0.5).max(0.1);
                (card.stability * w_penalty).max(0.1)
            }
            _ => {
                let grown = card.stability * (1.0 + stabilizer);
                grown.clamp(0.1, FSRS_MAXIMUM_INTERVAL)
            }
        };

        card.difficulty = new_difficulty;
        card.stability = new_stability;

        match rating {
            FsrsRating::Again => {
                card.lapses += 1;
                card.state = 3;
                card.scheduled_days = 1;
            }
            FsrsRating::Hard => {
                card.state = if card.scheduled_days <= 7 { 1 } else { 2 };
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
            FsrsRating::Good => {
                card.state = 2;
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
            FsrsRating::Easy => {
                card.state = 2;
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
        }

        card.elapsed_days = 0;
        card
    }

    fn next_interval(stability: f64) -> f64 {
        if stability <= 0.0 {
            return 1.0;
        }
        (stability * (1.0 / FSRS_REQUEST_RETENTION - 1.0) + 1.0).min(FSRS_MAXIMUM_INTERVAL)
    }
}

#[derive(Debug, Deserialize)]
pub struct ReviewCalcInput {
    pub card: FsrsCard,
    pub rating: FsrsRating,
}

#[derive(Debug, Serialize)]
pub struct ReviewCalcResult {
    pub status: String,
    pub interval: i64,
    pub next_review_at: String,
    pub card: FsrsCard,
}

#[tauri::command]
pub async fn calculate_next_review(input: ReviewCalcInput) -> Result<ReviewCalcResult, String> {
    let new_card = input.card.review(input.rating);

    let status = match input.rating {
        FsrsRating::Easy => "mastered",
        FsrsRating::Again => "learning",
        FsrsRating::Good if new_card.reps >= 3 => "mastered",
        _ => match new_card.state {
            0 => "new",
            2 if new_card.reps >= 3 => "mastered",
            _ => "learning",
        },
    };

    let interval = new_card.scheduled_days.max(1);
    let next_review_at = (chrono::Utc::now() + chrono::Duration::days(interval)).to_rfc3339();

    Ok(ReviewCalcResult {
        status: status.to_string(),
        interval,
        next_review_at,
        card: new_card,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_update_word_review_fsrs(
    db: State<'_, Db>,
    id: i64,
    status: String,
    review_count: i64,
    next_review_at: Option<String>,
    stability: f64,
    difficulty: f64,
    elapsed_days: i64,
    scheduled_days: i64,
    reps: i64,
    lapses: i64,
    state: i64,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "UPDATE words SET review_status = ?1, review_count = ?2, next_review_at = ?3, stability = ?4, difficulty = ?5, elapsed_days = ?6, scheduled_days = ?7, reps = ?8, lapses = ?9, state = ?10 WHERE id = ?11",
            params![status, review_count, next_review_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// Learning activity, streaks, and goals
// ============================================================================

#[tauri::command]
pub async fn db_record_learning_activity(
    db: State<'_, Db>,
    date: String,
    activity: LearningActivity,
) -> Result<(), String> {
    let key = activity.as_str();
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO learning_streaks (date, activities) VALUES (?1, json_set('{}', '$.' || ?2, 1)) ON CONFLICT(date) DO UPDATE SET activities = json_set(COALESCE(activities, '{}'), '$.' || ?2, COALESCE(json_extract(activities, '$.' || ?2), 0) + 1)",
            params![date, key],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn db_get_all_streaks(db: State<'_, Db>) -> Result<Vec<StreakRowDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT date, activities FROM learning_streaks ORDER BY date DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(StreakRowDto {
                    date: row.get(0)?,
                    activities: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect();
        Ok(rows)
    })
}

#[tauri::command]
pub async fn db_get_today_activities(
    db: State<'_, Db>,
    date: String,
) -> Result<Option<String>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT activities FROM learning_streaks WHERE date = ?1")
            .map_err(|e| e.to_string())?;
        let val = stmt
            .query_map(params![date], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .log_errors()
            .next();
        Ok(val)
    })
}

#[tauri::command]
pub async fn db_get_learning_goals(db: State<'_, Db>) -> Result<Vec<GoalDto>, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT goal_type, target FROM learning_goals")
            .map_err(|e| e.to_string())?;
        let goals = stmt
            .query_map([], |row| {
                Ok(GoalDto {
                    goal_type: row.get(0)?,
                    target: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .log_errors()
            .collect();
        Ok(goals)
    })
}

#[tauri::command]
pub async fn db_set_learning_goal(
    db: State<'_, Db>,
    goal_type: String,
    target: i64,
) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute(
            "INSERT INTO learning_goals (goal_type, target) VALUES (?1, ?2) ON CONFLICT(goal_type) DO UPDATE SET target = ?2",
            params![goal_type, target],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ============================================================================
// Export and backup
// ============================================================================

/// Export all vocabulary as CSV.
#[tauri::command]
pub async fn export_words_csv(db: State<'_, Db>) -> Result<String, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn.prepare(
            "SELECT word, phonetic, definition, level, source_type, notes, review_status, review_count, next_review_at, created_at FROM words ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
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
            })
            .map_err(|e| e.to_string())?;

        let mut wtr = csv::Writer::from_writer(Vec::new());
        wtr.write_record([
            "word",
            "phonetic",
            "definition",
            "level",
            "source_type",
            "notes",
            "review_status",
            "review_count",
            "next_review_at",
            "created_at",
        ])
        .map_err(|e| format!("CSV header error: {e}"))?;

        for (word, phonetic, definition, level, source_type, notes, status, count, nra, created) in
            rows.flatten()
        {
            wtr.write_record(&[
                word,
                phonetic.unwrap_or_default(),
                definition,
                level.unwrap_or_default(),
                source_type.unwrap_or_default(),
                notes.unwrap_or_default(),
                status,
                count.unwrap_or(0).to_string(),
                nra.unwrap_or_default(),
                created,
            ])
            .map_err(|e| format!("CSV write error: {e}"))?;
        }

        let bytes = wtr
            .into_inner()
            .map_err(|e| format!("CSV flush error: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("CSV encoding error: {e}"))
    })
}

/// Export all vocabulary in Anki import format (tab-separated).
#[tauri::command]
pub async fn export_words_anki(db: State<'_, Db>) -> Result<String, String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        let mut stmt = conn
            .prepare("SELECT word, phonetic, definition, notes FROM words ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;

        let mut output = String::new();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for (word, phonetic, definition, notes) in rows.flatten() {
            let phonetic_str = phonetic.as_deref().unwrap_or("");
            let notes_str = notes.as_deref().unwrap_or("");
            output.push_str(&format!(
                "{}\t{} <br> {} <br> {}\n",
                word, phonetic_str, definition, notes_str
            ));
        }
        Ok(output)
    })
}

/// Backup the database file to the specified path.
#[tauri::command]
pub async fn backup_db(db: State<'_, Db>, dest_path: String) -> Result<(), String> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
        let mut dest = rusqlite::Connection::open(&dest_path)
            .map_err(|e| format!("Failed to open backup destination: {e}"))?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dest)
            .map_err(|e| format!("Backup init failed: {e}"))?;
        backup
            .run_to_completion(100, std::time::Duration::from_millis(10), None)
            .map_err(|e| format!("Backup failed: {e}"))?;
        Ok(())
    })
}
