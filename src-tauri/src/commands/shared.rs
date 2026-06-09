/// Shared types, DTOs, and utilities used across command submodules.
use serde::{Deserialize, Serialize};

/// Whitelist of allowed learning activity types.
///
/// Used by [`db_record_learning_activity`] to prevent SQL injection via the
/// `activity` parameter, which is interpolated into a JSON path expression.
/// Deserialization from any other string value will fail at the serde layer,
/// before the value ever reaches a SQL query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearningActivity {
    Writing,
    Reading,
    Exercise,
    Listening,
    Review,
}

impl LearningActivity {
    /// Returns the string representation for use in SQL JSON paths.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Writing => "writing",
            Self::Reading => "reading",
            Self::Exercise => "exercise",
            Self::Listening => "listening",
            Self::Review => "review",
        }
    }
}

/// Extension trait to log row-level errors instead of silently discarding them.
pub trait RowResultIterExt: Iterator<Item = Result<Self::Ok, rusqlite::Error>> + Sized {
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
// Data Transfer Objects (DTOs)
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
    // FSRS fields (migration 007) — Option for backward compat with pre-migration rows
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub elapsed_days: Option<i64>,
    pub scheduled_days: Option<i64>,
    pub reps: Option<i64>,
    pub lapses: Option<i64>,
    pub state: Option<i64>,
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
// Helper macro: simplify DB lock + error conversion
// ============================================================================

macro_rules! with_db {
    ($db:expr, $body:expr) => {{
        let conn = $db.0.lock().map_err(|e| format!("DB lock error: {e}"))?;
        #[allow(clippy::redundant_closure_call)]
        {
            (|| -> Result<_, String> { $body(&conn) })()
        }
    }};
}
pub(crate) use with_db;

// ============================================================================
// Row mappers
// ============================================================================

pub fn row_to_word(row: &rusqlite::Row) -> rusqlite::Result<WordDto> {
    Ok(WordDto {
        id: row.get(0)?,
        word: row.get(1)?,
        phonetic: row.get(2)?,
        definition: row.get(3)?,
        level: row.get(4)?,
        source_type: row.get(5)?,
        source_text: row.get(6)?,
        notes: row.get(7)?,
        review_status: row.get(8)?,
        review_count: row.get(9)?,
        next_review_at: row.get(10)?,
        created_at: row.get(11)?,
        stability: row.get(12)?,
        difficulty: row.get(13)?,
        elapsed_days: row.get(14)?,
        scheduled_days: row.get(15)?,
        reps: row.get(16)?,
        lapses: row.get(17)?,
        state: row.get(18)?,
    })
}

pub fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryDto> {
    Ok(HistoryDto {
        id: row.get(0)?,
        record_type: row.get(1)?,
        input_text: row.get(2)?,
        result: row.get(3)?,
        graph_data: row.get(4)?,
        created_at: row.get(5)?,
    })
}
