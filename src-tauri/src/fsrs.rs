//! FSRS (Free Spaced Repetition Scheduler) 间隔重复算法模块。
//!
//! 封装 FSRS-4 算法的核心数据结构与调度逻辑，包括：
//! - [`FsrsRating`] 用户对卡片的评分（Again / Hard / Good / Easy）
//! - [`FsrsState`] 卡片学习状态（New / Learning / Review / Relearning）
//! - [`FsrsCard`] 单张卡片的 FSRS 状态（stability、difficulty 等参数）
//! - [`calculate_next_review_with_retention`] 根据评分和目标留存率计算下次复习调度
//!
//! ## 算法概述
//!
//! FSRS 基于记忆曲线模型，根据用户每次复习的评分动态调整：
//! - **稳定性 (stability)**：记忆保持时长，越高表示遗忘越慢
//! - **难度 (difficulty)**：卡片固有难度，影响稳定性增长率
//! - **间隔 (interval)**：下次复习的天数，由稳定性和目标留存率推导

use serde::{Deserialize, Serialize};

/// 各评分的初始稳定性（索引 1=Again, 2=Hard, 3=Good, 4=Easy）。
const FSRS_STABILITY_INIT: [f64; 5] = [0.0, 0.3, 0.8, 3.0, 5.0];

/// 各评分的初始难度（1=Again, 4=Easy）。
const FSRS_DIFFICULTY_INIT: [f64; 5] = [0.0, 8.0, 6.0, 4.0, 2.0];

/// 默认目标留存率（复习时的回忆概率）。
/// 用户可通过 settings 表的 `fsrs_request_retention` 键覆盖，见 [`resolve_retention`]。
pub const FSRS_DEFAULT_REQUEST_RETENTION: f64 = 0.9;

/// 目标留存率允许的最小值（过低会导致间隔过长、遗忘率过高）。
pub const FSRS_RETENTION_MIN: f64 = 0.7;

/// 目标留存率允许的最大值（过高会导致间隔过短、复习负担过重）。
pub const FSRS_RETENTION_MAX: f64 = 0.97;

/// 各评分的难度变化增量（索引 1=Again, 2=Hard, 3=Good, 4=Easy）。
/// 与标准 FSRS 的 `D' = D - w6*(r-3)`（w6=0.1）等价：
/// Again +0.2、Hard +0.1、Good ±0、Easy -0.1。
/// 注意：直接作为增量使用，不要再乘 (rating-3)（曾因此导致 Easy 方向反转）。
const FSRS_DIFFICULTY_WEIGHTS: [f64; 5] = [0.0, 0.2, 0.1, 0.0, -0.1];

/// 最大稳定性上限（10 年），防止溢出。
const FSRS_MAXIMUM_INTERVAL: f64 = 3650.0;

// ── Review formula parameters ──

/// 卡片难度最小值。
const DIFFICULTY_MIN: f64 = 1.0;
/// 卡片难度最大值。
const DIFFICULTY_MAX: f64 = 10.0;
/// 稳定性下限（天），防止除零和过度衰减。
const STABILITY_FLOOR: f64 = 0.1;
/// 记忆曲线衰减因子。
const DECAY_FACTOR: f64 = 9.0;
/// 低留存率阈值：低于此值时触发稳定性额外加成。
const RETENTION_LOW_THRESHOLD: f64 = 0.5;
/// 低留存率时的稳定性加成倍数。
const RETENTION_LOW_MULTIPLIER: f64 = 1.2;
/// Easy 评分的稳定性倍数。
const EASY_STABILITY_MULTIPLIER: f64 = 2.5;
/// Again 评分的惩罚因子系数。
const HARD_PENALTY_FACTOR: f64 = 0.5;
/// Again 评分惩罚的最小值。
const HARD_PENALTY_MIN: f64 = 0.1;
/// Hard 评分的 scheduled_days 阈值：低于此值保持 Learning 态。
const HARD_SCHEDULED_DAYS_THRESHOLD: i64 = 7;

// ── Mastery thresholds ──

/// Good 评分达到 mastered 所需的最低复习次数。
const MASTERED_REPS_GOOD: i64 = 3;
/// Hard 评分 / Review 态达到 mastered 所需的最低复习次数。
const MASTERED_REPS_HARD: i64 = 5;

/// 复习状态字符串常量（与前端 ReviewStatus 类型保持一致）。
/// 提取为常量避免在算法分支中散落魔术字符串，便于集中维护。
const REVIEW_STATUS_MASTERED: &str = "mastered";
const REVIEW_STATUS_LEARNING: &str = "learning";

/// FSRS 评分值。反序列化时接受小写字符串（如 `"again"`、`"good"`）。
///
/// 评分直接影响卡片的稳定性增长和难度调整：
/// - `Again` (1)：完全忘记，stability 大幅下降，记录一次 lapse
/// - `Hard` (2)：勉强回忆，stability 小幅增长
/// - `Good` (3)：正常回忆，stability 中等增长
/// - `Easy` (4)：轻松回忆，stability 大幅增长
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsrsRating {
    /// 完全忘记（评分值 1），触发 lapse 计数。
    Again, // 1
    /// 勉强回忆起来（评分值 2）。
    Hard, // 2
    /// 正常回忆（评分值 3），最常见的评分。
    Good, // 3
    /// 轻松回忆（评分值 4），可快速进入 mastered 状态。
    Easy, // 4
}

impl FsrsRating {
    /// 返回评分对应的数值（1=Again, 2=Hard, 3=Good, 4=Easy）。
    fn value(self) -> u8 {
        match self {
            Self::Again => 1,
            Self::Hard => 2,
            Self::Good => 3,
            Self::Easy => 4,
        }
    }
    /// 返回评分对应的数组索引（与 FSRS 参数数组对齐，0 位不使用）。
    fn index(self) -> usize {
        self.value() as usize
    }
}

/// FSRS 卡片状态枚举。在数据库中以 i64 编码存储，保持向后兼容。
///
/// P3-7: 用类型安全的 enum 替代裸 i64 + 常量模块，避免非法状态值流入算法逻辑。
/// `#[serde(into = "i64", from = "i64")]` 保证与前端 / DB 的 i64 编码兼容：
/// - 反序列化时通过 `From<i64>` 接受数字（含未知值的降级处理）
/// - 序列化时通过 `From<FsrsState> for i64` 输出数字
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "i64", from = "i64")]
#[repr(i64)]
pub enum FsrsState {
    /// 新卡片，从未复习过（DB 值 0）。
    New = 0,
    /// 学习中：首次复习后尚未完全掌握（DB 值 1）。
    Learning = 1,
    /// 复习态：已进入长期记忆调度循环（DB 值 2）。
    Review = 2,
    /// 重新学习：之前掌握但再次遗忘（Again 评分后进入此状态，DB 值 3）。
    Relearning = 3,
}

impl From<i64> for FsrsState {
    fn from(v: i64) -> Self {
        match v {
            0 => Self::New,
            1 => Self::Learning,
            2 => Self::Review,
            3 => Self::Relearning,
            _ => {
                tracing::warn!(state = v, "unknown FSRS state, falling back to New");
                Self::New
            }
        }
    }
}

impl From<FsrsState> for i64 {
    fn from(s: FsrsState) -> i64 {
        s as i64
    }
}

/// FSRS 单张卡片的算法状态，对应数据库 `words` 表中的 FSRS 相关列。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsrsCard {
    /// 记忆稳定性（天数），越高表示遗忘速度越慢。
    pub stability: f64,
    /// 卡片固有难度（1.0 ~ 10.0），越高表示越难记忆。
    pub difficulty: f64,
    /// 自上次复习以来经过的天数。
    pub elapsed_days: i64,
    /// 本次调度的复习间隔天数（下次复习距今天的天数）。
    pub scheduled_days: i64,
    /// 累计复习次数。
    pub reps: i64,
    /// 累计遗忘次数（Again 评分触发 +1）。
    pub lapses: i64,
    /// 当前学习状态，见 [`FsrsState`]。
    pub state: FsrsState, // 见 FsrsState enum：New=0, Learning=1, Review=2, Relearning=3
}

impl FsrsCard {
    /// 对卡片应用一次复习评分，返回更新后的卡片状态。
    ///
    /// 根据当前卡片状态和用户评分，更新稳定性、难度、间隔等参数。
    /// 对于新卡片（state=New），使用初始参数表；对于已有卡片，
    /// 基于 FSRS-4 的记忆曲线公式递推更新。
    ///
    /// # Arguments
    ///
    /// * `rating` - 用户对本次复习的评分（Again / Hard / Good / Easy）
    ///
    /// # Returns
    ///
    /// 更新后的 `FsrsCard`（`elapsed_days` 重置为 0，`reps` +1）。
    ///
    /// 生产路径通过 [`calculate_next_review_with_retention`] 使用可配置留存率，
    /// 本包装以默认留存率保留，供测试与外部 API 使用。
    #[allow(dead_code)]
    pub fn review(self, rating: FsrsRating) -> Self {
        self.review_with_retention(rating, FSRS_DEFAULT_REQUEST_RETENTION)
    }

    /// 与 [`FsrsCard::review`] 相同，但使用指定的目标留存率计算间隔。
    ///
    /// # Arguments
    ///
    /// * `rating` - 用户对本次复习的评分
    /// * `retention` - 目标留存率（调用方需保证已 clamp 到合法范围，见 [`resolve_retention`]）
    pub fn review_with_retention(self, rating: FsrsRating, retention: f64) -> Self {
        let mut card = self;
        let r = rating.index();
        let elapsed = card.elapsed_days as f64;

        // First review (state == New, stability == 0)
        if card.state == FsrsState::New {
            let initial_stability = FSRS_STABILITY_INIT[r];
            let initial_difficulty = FSRS_DIFFICULTY_INIT[r];
            let next_interval = Self::next_interval(initial_stability, retention);

            return Self {
                stability: initial_stability,
                difficulty: initial_difficulty,
                elapsed_days: 0,
                scheduled_days: next_interval as i64,
                reps: 1,
                lapses: if rating.value() == 1 { 1 } else { 0 },
                state: if rating.value() == 1 {
                    FsrsState::Learning
                } else {
                    FsrsState::Review
                },
            };
        }

        card.reps += 1;

        // 难度按评分直接增减：Again/Hard 变难、Easy 变易（Good 不变）。
        // 此前实现误写成 `-w[r] * (rating - 3)`，双重取反导致所有评分（含 Easy）
        // 都使 difficulty 单调上升，长期复习后难度触顶 10.0、稳定性增长趋近于零。
        let d_delta = FSRS_DIFFICULTY_WEIGHTS[r];
        let new_difficulty = (card.difficulty + d_delta).clamp(DIFFICULTY_MIN, DIFFICULTY_MAX);

        let r_val = if card.stability > 0.0 {
            (1.0 + elapsed / (DECAY_FACTOR * card.stability)).powf(-1.0)
        } else {
            0.0
        };

        let exp_component = (-0.1 * (card.reps as f64 - 1.0)).exp();
        let d_factor = (DIFFICULTY_MAX - new_difficulty) / DECAY_FACTOR;

        let stabilizer = match rating {
            FsrsRating::Again => 0.0,
            FsrsRating::Hard => {
                d_factor * 1.3_f64.powf(-(new_difficulty / DIFFICULTY_MAX)) * exp_component
            }
            FsrsRating::Good => {
                d_factor * (DIFFICULTY_MAX + 1.0 - new_difficulty) / DIFFICULTY_MAX
                    * (1.0_f64 - r_val)
                    * exp_component
                    * if r_val < RETENTION_LOW_THRESHOLD {
                        RETENTION_LOW_MULTIPLIER
                    } else {
                        1.0
                    }
            }
            FsrsRating::Easy => {
                d_factor * (DIFFICULTY_MAX + 1.0 - new_difficulty) / DIFFICULTY_MAX
                    * (1.0_f64 - r_val)
                    * exp_component
                    * EASY_STABILITY_MULTIPLIER
            }
        };

        let new_stability = match rating {
            FsrsRating::Again => {
                let w_penalty =
                    (new_difficulty / DIFFICULTY_MAX * HARD_PENALTY_FACTOR).max(HARD_PENALTY_MIN);
                (card.stability * w_penalty).max(STABILITY_FLOOR)
            }
            _ => {
                let grown = card.stability * (1.0 + stabilizer);
                grown.clamp(STABILITY_FLOOR, FSRS_MAXIMUM_INTERVAL)
            }
        };

        card.difficulty = new_difficulty;
        card.stability = new_stability;

        match rating {
            FsrsRating::Again => {
                card.lapses += 1;
                card.state = FsrsState::Relearning;
                card.scheduled_days = 1;
            }
            FsrsRating::Hard => {
                let new_scheduled_days =
                    Self::next_interval(new_stability, retention).max(1.0) as i64;
                // L-2: 使用新计算的 scheduled_days 判断状态，而非旧值
                card.state = if new_scheduled_days <= HARD_SCHEDULED_DAYS_THRESHOLD {
                    FsrsState::Learning
                } else {
                    FsrsState::Review
                };
                card.scheduled_days = new_scheduled_days;
            }
            FsrsRating::Good => {
                card.state = FsrsState::Review;
                card.scheduled_days = Self::next_interval(new_stability, retention).max(1.0) as i64;
            }
            FsrsRating::Easy => {
                card.state = FsrsState::Review;
                card.scheduled_days = Self::next_interval(new_stability, retention).max(1.0) as i64;
            }
        }

        card.elapsed_days = 0;
        card
    }

    /// 根据稳定性和目标留存率计算下次复习间隔（天数）。
    ///
    /// 从本模块的记忆曲线 `r(t) = (1 + t / (DECAY_FACTOR * S))^-1`（见 review_with_retention
    /// 中 r_val 的计算）反解 r(t) = retention 对应的间隔：
    /// `t = DECAY_FACTOR * S * (1/retention - 1)`。
    /// 默认 retention=0.9 时 interval ≈ S，与标准 FSRS-4.5 的 `I(r,S) ≈ S` 一致。
    /// 结果受 [`FSRS_MAXIMUM_INTERVAL`] 上限约束（最多 10 年），下限 1 天。
    /// 留存率越低，允许的间隔越长（复习负担越轻）。
    fn next_interval(stability: f64, retention: f64) -> f64 {
        if stability <= 0.0 {
            return 1.0;
        }
        (DECAY_FACTOR * stability * (1.0 / retention - 1.0)).clamp(1.0, FSRS_MAXIMUM_INTERVAL)
    }
}

/// 将 settings 表中存储的留存率字符串解析为合法的 f64 值。
///
/// - `None` / 解析失败 / 非有限值 → 回退默认值 [`FSRS_DEFAULT_REQUEST_RETENTION`]
/// - 超出范围的值 clamp 到 [`FSRS_RETENTION_MIN`, `FSRS_RETENTION_MAX`]
pub fn resolve_retention(raw: Option<&str>) -> f64 {
    match raw.and_then(|s| s.trim().parse::<f64>().ok()) {
        Some(v) if v.is_finite() => v.clamp(FSRS_RETENTION_MIN, FSRS_RETENTION_MAX),
        _ => FSRS_DEFAULT_REQUEST_RETENTION,
    }
}

/// [`calculate_next_review_with_retention`] 的入参，包含当前卡片状态和用户评分。
#[derive(Debug, Deserialize)]
pub struct ReviewCalcInput {
    /// 当前卡片的 FSRS 状态。
    pub card: FsrsCard,
    /// 用户对本次复习的评分。
    pub rating: FsrsRating,
}

/// [`calculate_next_review_with_retention`] 的返回结果，包含调度信息和更新后的卡片状态。
#[derive(Debug, Serialize)]
pub struct ReviewCalcResult {
    /// 学习状态标签（`"learning"` 或 `"mastered"`），与前端 ReviewStatus 类型对应。
    pub status: String,
    /// 下次复习的间隔天数（至少为 1）。
    pub interval: i64,
    /// 下次复习的日期时间（SQLite datetime 兼容格式：YYYY-MM-DD HH:MM:SS，本地时区）。
    pub next_review_at: String,
    /// 更新后的卡片 FSRS 状态。
    pub card: FsrsCard,
}

/// P3-8: db_update_word_review_fsrs 的入参 struct，替代原先 12 个独立参数。
/// 前端通过 invoke 传递一个对象，Tauri 将其反序列化为本结构。
/// `card` 字段直接复用 FsrsCard（其 state 已是 FsrsState enum）。
#[derive(Debug, Deserialize)]
pub struct FsrsReviewUpdate {
    /// 要更新的单词 ID。
    pub id: i64,
    /// 更新后的学习状态标签（`"new"` / `"learning"` / `"mastered"`）。
    pub status: String,
    /// 更新后的累计复习次数。
    pub review_count: i64,
    /// 下次复习时间（SQLite datetime 兼容格式，可选）。
    pub next_review_at: Option<String>,
    /// 更新后的完整卡片 FSRS 状态。
    pub card: FsrsCard,
}

/// 对输入卡片应用评分，计算下次复习的调度结果。
///
/// 内部调用 [`FsrsCard::review`] 更新卡片状态，然后根据评分和复习次数
/// 判定学习状态（learning / mastered），并生成下次复习日期。
///
/// # Arguments
///
/// * `input` - 包含当前卡片状态和用户评分的输入结构
/// * `retention` - 目标留存率，来源于用户设置（settings 表 `fsrs_request_retention` 键），
///   调用方通过 [`resolve_retention`] 解析并 clamp 后传入
///
/// # Returns
///
/// 包含状态标签、间隔天数、下次复习时间和更新后卡片状态的结果。
pub fn calculate_next_review_with_retention(
    input: ReviewCalcInput,
    retention: f64,
) -> ReviewCalcResult {
    let new_card = input.card.review_with_retention(input.rating, retention);

    // review() 返回的 state 只会是 Learning/Review/Relearning（非 New），
    // 因此无需匹配 New 分支。
    let status = match input.rating {
        FsrsRating::Easy => REVIEW_STATUS_MASTERED,
        FsrsRating::Again => REVIEW_STATUS_LEARNING,
        // L-3: Good/Hard 评分在累计复习 >= 5 次后也可达到 mastered（Hard 门槛更高）
        FsrsRating::Good if new_card.reps >= MASTERED_REPS_GOOD => REVIEW_STATUS_MASTERED,
        FsrsRating::Hard if new_card.reps >= MASTERED_REPS_HARD => REVIEW_STATUS_MASTERED,
        _ => match new_card.state {
            FsrsState::Review if new_card.reps >= MASTERED_REPS_HARD => REVIEW_STATUS_MASTERED,
            _ => REVIEW_STATUS_LEARNING,
        },
    };

    let interval = new_card.scheduled_days.max(1);
    // B-12: 使用 SQLite datetime 兼容格式（YYYY-MM-DD HH:MM:SS），确保
    // next_review_at <= datetime('now', 'localtime') 比较正确。RFC 3339 格式含 'T' 分隔符
    // 导致 TEXT 比较永远为 FALSE，已复习单词永远不会回到复习队列。
    // 注意：这里写入的是本地时间（无时区标记），words.rs 中的到期比较必须
    // 带 'localtime' 修饰符 —— datetime('now') 返回 UTC，混用会错位一个时区偏移。
    let next_review_at = (chrono::Local::now() + chrono::Duration::days(interval))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    ReviewCalcResult {
        status: status.to_string(),
        interval,
        next_review_at,
        card: new_card,
    }
}

// ============================================================================
// Unit tests — 覆盖 FSRS 算法的核心调度逻辑与状态转换
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一张全新的卡片（state=New, stability=0, reps=0）用于首评测试。
    fn new_card() -> FsrsCard {
        FsrsCard {
            stability: 0.0,
            difficulty: 0.0,
            elapsed_days: 0,
            scheduled_days: 0,
            reps: 0,
            lapses: 0,
            state: FsrsState::New,
        }
    }

    // ── 首次评分：Again 应进入 Learning 态并记一次 lapse ──

    #[test]
    fn first_review_again_yields_learning_state_and_lapse() {
        let card = new_card();
        let result = card.review(FsrsRating::Again);
        assert_eq!(
            result.state,
            FsrsState::Learning,
            "Again 首评应进入 Learning 态"
        );
        assert_eq!(result.lapses, 1, "Again 首评应记一次 lapse");
        assert_eq!(result.reps, 1, "首评后 reps 应为 1");
        assert_eq!(result.elapsed_days, 0, "review 后 elapsed_days 应重置为 0");
    }

    // ── 首次评分：Easy 应进入 Review 态且 scheduled_days >= 1 ──

    #[test]
    fn first_review_easy_yields_review_state() {
        let card = new_card();
        let result = card.review(FsrsRating::Easy);
        assert_eq!(result.state, FsrsState::Review, "Easy 首评应进入 Review 态");
        assert_eq!(result.lapses, 0, "Easy 首评不应记 lapse");
        assert_eq!(result.reps, 1, "首评后 reps 应为 1");
        assert!(
            result.scheduled_days >= 1,
            "Easy 首评 scheduled_days 应 >=1，实际: {}",
            result.scheduled_days
        );
        // Easy 的初始 stability 较大，应得到比 Again 更长的间隔
        let again_card = new_card().review(FsrsRating::Again);
        assert!(
            result.scheduled_days >= again_card.scheduled_days,
            "Easy 的间隔应不小于 Again 的间隔"
        );
    }

    // ── calculate_next_review: next_review_at 格式正确且在未来 ──

    #[test]
    fn calculate_next_review_uses_local_time() {
        let input = ReviewCalcInput {
            card: new_card(),
            rating: FsrsRating::Good,
        };
        let now = chrono::Local::now();
        let result = calculate_next_review_with_retention(input, FSRS_DEFAULT_REQUEST_RETENTION);

        // next_review_at 应为 SQLite datetime 兼容格式（YYYY-MM-DD HH:MM:SS）
        let next =
            chrono::NaiveDateTime::parse_from_str(&result.next_review_at, "%Y-%m-%d %H:%M:%S")
                .expect("next_review_at 应为 YYYY-MM-DD HH:MM:SS 格式");

        // 间隔至少 1 天，因此 next_review_at 必然在未来（允许 1 秒时钟漂移）
        let next_local = next
            .and_local_timezone(chrono::Local)
            .single()
            .expect("应能转换为本地时区");
        assert!(
            next_local > now - chrono::Duration::seconds(1),
            "next_review_at 应在未来，now={now}, next={next_local}"
        );
        assert!(result.interval >= 1, "interval 应 >=1");
    }

    // ── status 字符串映射：again→learning, easy→mastered 等 ──

    #[test]
    fn status_mapping() {
        // Again → learning
        let result = calculate_next_review_with_retention(
            ReviewCalcInput {
                card: new_card(),
                rating: FsrsRating::Again,
            },
            FSRS_DEFAULT_REQUEST_RETENTION,
        );
        assert_eq!(result.status, "learning", "Again 应映射为 learning");

        // Easy → mastered
        let result = calculate_next_review_with_retention(
            ReviewCalcInput {
                card: new_card(),
                rating: FsrsRating::Easy,
            },
            FSRS_DEFAULT_REQUEST_RETENTION,
        );
        assert_eq!(result.status, "mastered", "Easy 应映射为 mastered");

        // Good（首评，reps=1 < 3）→ learning
        let result = calculate_next_review_with_retention(
            ReviewCalcInput {
                card: new_card(),
                rating: FsrsRating::Good,
            },
            FSRS_DEFAULT_REQUEST_RETENTION,
        );
        assert_eq!(result.status, "learning", "Good 首评应映射为 learning");

        // Hard（首评，reps=1 < 3）→ learning
        let result = calculate_next_review_with_retention(
            ReviewCalcInput {
                card: new_card(),
                rating: FsrsRating::Hard,
            },
            FSRS_DEFAULT_REQUEST_RETENTION,
        );
        assert_eq!(result.status, "learning", "Hard 首评应映射为 learning");
    }

    // ── FsrsState enum 的 From<i64> / From<FsrsState> for i64 转换 ──

    #[test]
    fn fsrs_state_enum_conversions() {
        // From<i64>：已知值映射到对应变体
        assert_eq!(FsrsState::from(0i64), FsrsState::New);
        assert_eq!(FsrsState::from(1i64), FsrsState::Learning);
        assert_eq!(FsrsState::from(2i64), FsrsState::Review);
        assert_eq!(FsrsState::from(3i64), FsrsState::Relearning);

        // From<i64>：未知值降级为 New（不 panic）
        assert_eq!(
            FsrsState::from(99i64),
            FsrsState::New,
            "未知 state 值应降级为 New"
        );
        assert_eq!(FsrsState::from(-1i64), FsrsState::New);

        // From<FsrsState> for i64：变体映射回数字（与 DB 编码一致）
        assert_eq!(i64::from(FsrsState::New), 0);
        assert_eq!(i64::from(FsrsState::Learning), 1);
        assert_eq!(i64::from(FsrsState::Review), 2);
        assert_eq!(i64::from(FsrsState::Relearning), 3);

        // 往返一致性：i64 → FsrsState → i64
        for v in 0..=3 {
            assert_eq!(i64::from(FsrsState::from(v)), v, "往返转换应保持原值");
        }
    }

    // ── 二次评分：Good 在 Review 态下应增长 stability ──

    #[test]
    fn second_review_good_grows_stability() {
        // 先 Easy 首评进入 Review 态，并让 elapsed_days 达到排定的间隔。
        // 记忆曲线在 elapsed=0 时 r=1，stabilizer 含 (1-r)=0 项，当天重评不增长
        // ——因此必须用到期后的卡片断言"严格增长"（旧断言用 `|| >0` 掩盖过问题）。
        let mut card = new_card().review(FsrsRating::Easy);
        assert_eq!(card.state, FsrsState::Review);
        card.elapsed_days = card.scheduled_days;
        let prev_stability = card.stability;

        // 再 Good 评分，stability 应严格增长
        let result = card.review(FsrsRating::Good);
        assert_eq!(result.state, FsrsState::Review);
        assert_eq!(result.reps, 2);
        assert!(
            result.stability > prev_stability,
            "Good 评分后 stability 应严格增长: {prev_stability} -> {}",
            result.stability
        );
        // retention=0.9 时间隔 ≈ 新 stability，应不小于上一轮的 5 天
        assert!(
            result.scheduled_days >= 5,
            "间隔应随 stability 同步增长（上一轮为 5 天），实际: {}",
            result.scheduled_days
        );
    }

    // ── P0 回归：间隔公式与自身记忆曲线自洽（retention=0.9 时 interval ≈ S）──

    #[test]
    fn next_interval_matches_forgetting_curve() {
        // 记忆曲线 r(t) = (1 + t/(9S))^-1，反解 r=0.9 得 t = 9S*(1/0.9-1) ≈ S。
        // 旧实现为 S*(1/0.9-1)+1 ≈ 0.11S，比模型预期短约 9 倍。
        let good = new_card().review(FsrsRating::Good); // 初始 stability = 3.0
        assert_eq!(good.stability, 3.0);
        assert_eq!(
            good.scheduled_days, 3,
            "Good 首评间隔应约等于初始 stability（3 天）"
        );

        let easy = new_card().review(FsrsRating::Easy); // 初始 stability = 5.0
        assert_eq!(easy.stability, 5.0);
        assert_eq!(
            easy.scheduled_days, 5,
            "Easy 首评间隔应约等于初始 stability（5 天），旧实现只有 1 天"
        );
    }

    // ── P0 回归：难度更新方向（Again 变难、Easy 变易）──

    #[test]
    fn difficulty_moves_in_rating_direction() {
        let base = new_card().review(FsrsRating::Good); // 初始 difficulty = 4.0
        assert_eq!(base.difficulty, 4.0);
        let base_difficulty = base.difficulty;

        // Easy 评分应降低难度（旧实现因符号反转反而升高）
        let easy = base.clone().review(FsrsRating::Easy);
        assert!(
            easy.difficulty < base_difficulty,
            "Easy 应降低难度: {base_difficulty} -> {}",
            easy.difficulty
        );

        // Again 评分应升高难度
        let again = base.clone().review(FsrsRating::Again);
        assert!(
            again.difficulty > base_difficulty,
            "Again 应升高难度: {base_difficulty} -> {}",
            again.difficulty
        );

        // Good 评分难度不变
        let good = base.review(FsrsRating::Good);
        assert_eq!(good.difficulty, base_difficulty, "Good 不改变难度");
    }

    // ── resolve_retention: 解析、clamp 与回退 ──

    #[test]
    fn resolve_retention_parses_and_clamps() {
        // 合法值直接解析
        assert_eq!(resolve_retention(Some("0.85")), 0.85);
        assert_eq!(resolve_retention(Some(" 0.9 ")), 0.9, "应容忍首尾空白");

        // 超出范围 clamp 到边界
        assert_eq!(resolve_retention(Some("0.5")), FSRS_RETENTION_MIN);
        assert_eq!(resolve_retention(Some("0.99")), FSRS_RETENTION_MAX);

        // None / 解析失败 / 非有限值 → 回退默认值
        assert_eq!(resolve_retention(None), FSRS_DEFAULT_REQUEST_RETENTION);
        assert_eq!(
            resolve_retention(Some("abc")),
            FSRS_DEFAULT_REQUEST_RETENTION
        );
        assert_eq!(
            resolve_retention(Some("NaN")),
            FSRS_DEFAULT_REQUEST_RETENTION,
            "NaN 应回退默认值"
        );
        assert_eq!(resolve_retention(Some("")), FSRS_DEFAULT_REQUEST_RETENTION);
    }

    // ── 留存率影响间隔：留存率越低，间隔越长 ──

    #[test]
    fn lower_retention_yields_longer_interval() {
        // 用同一张 Review 态卡片在不同留存率下评 Good，对比间隔
        let base = new_card().review(FsrsRating::Easy);

        let relaxed = base
            .clone()
            .review_with_retention(FsrsRating::Good, FSRS_RETENTION_MIN);
        let intensive = base
            .clone()
            .review_with_retention(FsrsRating::Good, FSRS_RETENTION_MAX);
        let default = base.review_with_retention(FsrsRating::Good, FSRS_DEFAULT_REQUEST_RETENTION);

        assert!(
            relaxed.scheduled_days >= default.scheduled_days,
            "低留存率间隔应不短于默认：{} vs {}",
            relaxed.scheduled_days,
            default.scheduled_days
        );
        assert!(
            default.scheduled_days >= intensive.scheduled_days,
            "默认间隔应不短于高留存率：{} vs {}",
            default.scheduled_days,
            intensive.scheduled_days
        );
    }
}
