//! 领域 DTO 与行映射器 —— 供 repository 与 commands 共同使用。
//!
//! 刻意不放在 `commands` 下：repository 是更内层的持久化实现，不应依赖
//! 命令层（依赖倒置）。commands 通过 `shared` 再导出本模块以保持命令侧
//! 导入路径稳定。
//!
//! 包含：
//! - 学习活动类型枚举 [`LearningActivity`]
//! - 数据传输对象（DTO）：[`ModelDto`]、[`WordDto`]、[`HistoryDto`] 等
//! - 入参结构：[`NewModelInput`]、[`NewWordInput`]
//! - 行映射器：[`row_to_word`]、`row_to_history`

use serde::{Deserialize, Serialize};

/// 学习活动类型白名单枚举。
///
/// 用于 `db_record_learning_activity` 命令，通过 serde 反序列化
/// 防止 SQL 注入（`activity` 参数会被插入 JSON 路径表达式）。
/// 非法字符串值在 serde 层即被拒绝，不会到达 SQL 查询。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearningActivity {
    /// 写作批改
    Writing,
    /// 阅读精读
    Reading,
    /// 弱项训练
    Exercise,
    /// 听力练习
    Listening,
    /// 口语练习
    Speaking,
    /// 词汇复习
    Review,
}

impl LearningActivity {
    /// 全部活动类型的字符串标识 —— 单一事实来源。
    /// 新增活动类型时只需加枚举变体 + 此处条目；一致性由测试锁死。
    #[allow(dead_code)]
    pub const ALL: &'static [&'static str] = &[
        "writing",
        "reading",
        "exercise",
        "listening",
        "speaking",
        "review",
    ];

    /// 返回活动类型的小写字符串标识，用于 SQL JSON 路径。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Writing => "writing",
            Self::Reading => "reading",
            Self::Exercise => "exercise",
            Self::Listening => "listening",
            Self::Speaking => "speaking",
            Self::Review => "review",
        }
    }
}

// ============================================================================
// Data Transfer Objects (DTOs)
// ============================================================================

/// 模型配置 DTO（前端渲染用）。
///
/// `api_key` 仅在明文豁免命令中填充（`get_model_api_key` / `db_get_default_model`，
/// 见 proxy.rs 模块文档的豁免清单）；`db_get_models` 返回时该字段刻意置空。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelDto {
    pub id: i64,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

/// 新增模型时前端传入的参数结构。
#[derive(Debug, Deserialize)]
pub struct NewModelInput {
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

/// `db_add_word` 的入参 struct，替代原先 10 个独立参数。
#[derive(Debug, Deserialize)]
pub struct NewWordInput {
    pub word: String,
    pub phonetic: Option<String>,
    pub definition: String,
    pub level: Option<String>,
    pub source_type: Option<String>,
    pub source_text: Option<String>,
    pub notes: Option<String>,
    pub review_status: Option<String>,
}

/// 单词 DTO（前端渲染用），包含完整字段（含 FSRS 状态）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub elapsed_days: Option<i64>,
    pub scheduled_days: Option<i64>,
    pub reps: Option<i64>,
    pub lapses: Option<i64>,
    pub state: Option<i64>,
}

/// 学习历史记录 DTO。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HistoryDto {
    pub id: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub input_text: String,
    pub result: String,
    pub graph_data: Option<String>,
    pub created_at: String,
}

/// 按 id 关联的历史 result 对。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryResultDto {
    pub id: i64,
    pub result: String,
}

/// 复习统计概览 DTO。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReviewStatsDto {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub mastered_count: i64,
    pub due_count: i64,
}

/// 学习打卡记录 DTO。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreakRowDto {
    pub date: String,
    pub activities: String,
}

/// 学习目标 DTO。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalDto {
    pub goal_type: String,
    pub target: i64,
}

/// Sidebar 聚合数据 DTO。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarDataDto {
    pub review_stats: ReviewStatsDto,
    pub streak: i64,
    pub goals: Vec<GoalDto>,
    pub today_activities: Option<String>,
}

/// TTS（文本转语音）完整配置 DTO。
///
/// `api_key` 从 OS Keychain 读取；其他字段从数据库 settings 表读取。
/// `dialect` 显式声明 TTS 协议方言（"mimo" | "openai"），避免用模型名前缀猜测。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsConfigDto {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub voice: String,
    pub speed: f64,
    /// TTS 协议方言："mimo"（默认）或 "openai"
    #[serde(default = "default_tts_dialect")]
    pub dialect: String,
}

fn default_tts_dialect() -> String {
    "mimo".into()
}

// ============================================================================
// Row mappers
// ============================================================================

/// 将 SQLite 结果行映射为 [`WordDto`]（19 列，含 FSRS 字段）。
pub fn row_to_word(row: &rusqlite::Row) -> rusqlite::Result<WordDto> {
    Ok(WordDto {
        id: row.get("id")?,
        word: row.get("word")?,
        phonetic: row.get("phonetic")?,
        definition: row.get("definition")?,
        level: row.get("level")?,
        source_type: row.get("source_type")?,
        source_text: row.get("source_text")?,
        notes: row.get("notes")?,
        review_status: row.get("review_status")?,
        review_count: row.get("review_count")?,
        next_review_at: row.get("next_review_at")?,
        created_at: row.get("created_at")?,
        stability: row.get("stability")?,
        difficulty: row.get("difficulty")?,
        elapsed_days: row.get("elapsed_days")?,
        scheduled_days: row.get("scheduled_days")?,
        reps: row.get("reps")?,
        lapses: row.get("lapses")?,
        state: row.get("state")?,
    })
}

/// 将 SQLite 结果行映射为 [`HistoryDto`]（6 列）。
pub fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryDto> {
    Ok(HistoryDto {
        id: row.get("id")?,
        record_type: row.get("type")?,
        input_text: row.get("input_text")?,
        result: row.get("result")?,
        graph_data: row.get("graph_data")?,
        created_at: row.get("created_at")?,
    })
}

#[cfg(test)]
mod whitelist_consistency_tests {
    use super::*;

    #[test]
    fn learning_activity_all_matches_as_str_variants() {
        let variants = [
            LearningActivity::Writing,
            LearningActivity::Reading,
            LearningActivity::Exercise,
            LearningActivity::Listening,
            LearningActivity::Speaking,
            LearningActivity::Review,
        ];
        for v in variants {
            assert!(
                LearningActivity::ALL.contains(&v.as_str()),
                "{} 应出现在 LearningActivity::ALL",
                v.as_str()
            );
        }
        assert_eq!(
            LearningActivity::ALL.len(),
            variants.len(),
            "ALL 不应有冗余条目"
        );
    }
}
