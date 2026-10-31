//! 领域 DTO 与行映射器 —— 供 repository 与 commands 共同使用。
//!
//! 刻意不放在 `commands` 下：repository 是更内层的持久化实现，不应依赖
//! 命令层（依赖倒置）。commands 通过 `shared` 再导出本模块以保持命令侧
//! 导入路径稳定。
//!
//! 包含：
//! - 学习活动类型枚举 [`LearningActivity`]
//! - 数据传输对象（DTO）：[`ModelRow`]/[`ModelWithSecret`]（模型密钥拆分，
//!   豁免清单见 commands/proxy.rs 模块文档）、[`WordDto`]、[`HistoryDto`] 等
//! - 入参结构：[`NewModelInput`]、[`NewWordInput`]
//! - 行映射器：[`row_to_word`]、`row_to_history`

use serde::{Deserialize, Serialize, Serializer};

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

/// 模型配置行 DTO —— **不含密钥字段**，列表/内部查询路径使用。
///
/// `db_get_models` 等非豁免命令返回本类型。序列化时恒输出 `api_key: ""`
/// 以保持既有 wire 形状（TS 侧依赖该字段存在，见 `src/types/index.ts` 的
/// `ModelConfig.api_key`）；前端以 `api_key` 非空作"已配置模型"判据仅对
/// 豁免命令的输出成立，对列表输出恒不成立。
///
/// 真实模型 Key 只经 [`ModelWithSecret`] 流转——其构造点即
/// commands/proxy.rs 模块文档豁免清单登记的路径。本类型在类型层面
/// 关断了"新命令顺手带回明文 Key"的路径。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ModelRow {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

// 手工 Serialize：保持历史 6 字段 JSON 形状，`api_key` 恒序列化为空串。
// 不用 derive——本类型刻意没有 api_key 字段，无法承载真值。
impl Serialize for ModelRow {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ModelRow", 6)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("api_key", "")?;
        state.serialize_field("base_url", &self.base_url)?;
        state.serialize_field("model_name", &self.model_name)?;
        state.serialize_field("is_default", &self.is_default)?;
        state.end()
    }
}

/// 带明文 API Key 的模型配置 —— **仅密钥豁免路径可达**。
///
/// 与 [`ModelRow`] 同字段 + `api_key`（从 OS Keychain 读取的真实 Key）。
/// 能携带真实模型 Key 到达 WebView 的 DTO 仅此一种：当前持有方为豁免
/// 清单条目 3 的 `db_get_default_model`（commands/models.rs）与 Rust 代理
/// 内部 `load_model_config`（commands/proxy.rs，密钥不出主进程，不构成
/// WebView 暴露）。新代码持有本类型即触碰密钥暴露面，须先登记
/// commands/proxy.rs 模块文档的豁免清单。
///
/// 构造统一走 [`ModelWithSecret::from_row_with_key`]（repository 层
/// Keychain 读钥的唯一入口），不要再散落结构体字面量。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelWithSecret {
    pub id: i64,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub is_default: bool,
}

impl ModelWithSecret {
    /// 由无密钥行 + Keychain 明文 Key 组装（repository 层唯一构造入口）。
    pub fn from_row_with_key(row: ModelRow, api_key: String) -> Self {
        Self {
            id: row.id,
            name: row.name,
            api_key,
            base_url: row.base_url,
            model_name: row.model_name,
            is_default: row.is_default,
        }
    }
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

/// 生词分页 DTO：`items` 为当前页，`total` 为**同一筛选条件**下的总行数。
///
/// `total` 由 `SELECT COUNT(*)` 与分页查询共用同一 WHERE 条件计算，
/// 供前端渲染分页器/统计，而不必先拉全表。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WordPageDto {
    pub items: Vec<WordDto>,
    pub total: i64,
}

/// 生词等级 × 复习状态聚合行（`GROUP BY level, review_status`）。
///
/// `level` 为 `None` 表示未标记等级的单词组。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordLevelStatDto {
    pub level: Option<String>,
    pub review_status: String,
    pub count: i64,
}

/// 批量添加单词的单条结果。
///
/// - 成功插入：`id = Some(new_id), inserted = true, error = None`
/// - 已存在（含大小写变体）：`id = Some(existing_id), inserted = false, error = None`
/// - 单条校验/写入失败：`id = None, inserted = false, error = Some(message)`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchWordResultDto {
    pub id: Option<i64>,
    pub inserted: bool,
    pub error: Option<String>,
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
    /// 本次练习生成时使用的 CEFR 级别码（A2..C1，见前端 src/lib/levels.ts）；
    /// 级别体系上线前的存量记录为 None
    pub difficulty_level: Option<String>,
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

/// 将 SQLite 结果行映射为 [`HistoryDto`]（7 列）。
pub fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryDto> {
    Ok(HistoryDto {
        id: row.get("id")?,
        record_type: row.get("type")?,
        input_text: row.get("input_text")?,
        result: row.get("result")?,
        graph_data: row.get("graph_data")?,
        difficulty_level: row.get("difficulty_level")?,
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

#[cfg(test)]
mod model_row_tests {
    use super::*;

    fn sample_row() -> ModelRow {
        ModelRow {
            id: 7,
            name: "GPT-4".into(),
            base_url: "https://api.openai.com/v1".into(),
            model_name: "gpt-4".into(),
            is_default: true,
        }
    }

    /// wire 兼容：非豁免命令输出的 JSON 仍含 api_key 且恒为空串
    /// （TS 侧 ModelConfig 依赖该字段存在）。
    #[test]
    fn model_row_serializes_api_key_as_empty_string() {
        let json = serde_json::to_value(sample_row()).unwrap();
        assert_eq!(json["api_key"], "");
        assert_eq!(json["id"], 7);
        assert_eq!(json["name"], "GPT-4");
        assert_eq!(json["base_url"], "https://api.openai.com/v1");
        assert_eq!(json["model_name"], "gpt-4");
        assert_eq!(json["is_default"], true);
    }

    /// 带真钥的输出只有 ModelWithSecret 可达（密钥拆分后唯一持钥类型）。
    #[test]
    fn model_with_secret_carries_real_key() {
        let model = ModelWithSecret::from_row_with_key(sample_row(), "sk-real".into());
        assert_eq!(model.api_key, "sk-real");
        let json = serde_json::to_value(&model).unwrap();
        assert_eq!(json["api_key"], "sk-real");
        assert_eq!(json["id"], 7);
        assert_eq!(json["name"], "GPT-4");
        assert_eq!(json["is_default"], true);
    }

    /// ModelRow 反序列化接受历史 6 字段 JSON：外来 api_key 被忽略，
    /// 再序列化时恒为空——类型层面不保留、不回流失钥。
    #[test]
    fn model_row_deserialization_ignores_api_key() {
        let json = r#"{"id":1,"name":"n","api_key":"sk-x","base_url":"b","model_name":"m","is_default":false}"#;
        let row: ModelRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, 1);
        assert_eq!(row.name, "n");
        assert_eq!(serde_json::to_value(&row).unwrap()["api_key"], "");
    }
}
