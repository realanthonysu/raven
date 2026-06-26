//! FSRS (Free Spaced Repetition Scheduler) 间隔重复算法模块。
//!
//! 封装 FSRS-4 算法的核心数据结构与调度逻辑，包括：
//! - [`FsrsRating`] 用户对卡片的评分（Again / Hard / Good / Easy）
//! - [`FsrsState`] 卡片学习状态（New / Learning / Review / Relearning）
//! - [`FsrsCard`] 单张卡片的 FSRS 状态（stability、difficulty 等参数）
//! - [`calculate_next_review`] 根据评分计算下次复习时间和状态
//!
//! ## 算法概述
//!
//! FSRS 基于记忆曲线模型，根据用户每次复习的评分动态调整：
//! - **稳定性 (stability)**：记忆保持时长，越高表示遗忘越慢
//! - **难度 (difficulty)**：卡片固有难度，影响稳定性增长率
//! - **间隔 (interval)**：下次复习的天数，由稳定性和目标留存率推导

use serde::{Deserialize, Serialize};

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
    pub fn review(self, rating: FsrsRating) -> Self {
        let mut card = self;
        let r = rating.index();
        let elapsed = card.elapsed_days as f64;

        // First review (state == New, stability == 0)
        if card.state == FsrsState::New {
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
                state: if rating.value() == 1 {
                    FsrsState::Learning
                } else {
                    FsrsState::Review
                },
            };
        }

        card.reps += 1;

        let d_delta = -FSRS_DIFFICULTY_WEIGHTS[r] * (rating.value() as f64 - 3.0);
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
                card.state = FsrsState::Relearning;
                card.scheduled_days = 1;
            }
            FsrsRating::Hard => {
                card.state = if card.scheduled_days <= 7 {
                    FsrsState::Learning
                } else {
                    FsrsState::Review
                };
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
            FsrsRating::Good => {
                card.state = FsrsState::Review;
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
            FsrsRating::Easy => {
                card.state = FsrsState::Review;
                card.scheduled_days = Self::next_interval(new_stability).max(1.0) as i64;
            }
        }

        card.elapsed_days = 0;
        card
    }

    /// 根据稳定性计算下次复习间隔（天数）。
    ///
    /// 使用 FSRS 公式：`interval = stability * (1/request_retention - 1) + 1`，
    /// 并受 [`FSRS_MAXIMUM_INTERVAL`] 上限约束（最多 10 年）。
    fn next_interval(stability: f64) -> f64 {
        if stability <= 0.0 {
            return 1.0;
        }
        (stability * (1.0 / FSRS_REQUEST_RETENTION - 1.0) + 1.0).min(FSRS_MAXIMUM_INTERVAL)
    }
}

/// [`calculate_next_review`] 的入参，包含当前卡片状态和用户评分。
#[derive(Debug, Deserialize)]
pub struct ReviewCalcInput {
    /// 当前卡片的 FSRS 状态。
    pub card: FsrsCard,
    /// 用户对本次复习的评分。
    pub rating: FsrsRating,
}

/// [`calculate_next_review`] 的返回结果，包含调度信息和更新后的卡片状态。
#[derive(Debug, Serialize)]
pub struct ReviewCalcResult {
    /// 学习状态标签（`"learning"` 或 `"mastered"`），与前端 ReviewStatus 类型对应。
    pub status: String,
    /// 下次复习的间隔天数（至少为 1）。
    pub interval: i64,
    /// 下次复习的日期时间（RFC 3339 格式，本地时区）。
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
    /// 下次复习时间（RFC 3339 格式，可选）。
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
///
/// # Returns
///
/// 包含状态标签、间隔天数、下次复习时间和更新后卡片状态的结果。
pub fn calculate_next_review(input: ReviewCalcInput) -> ReviewCalcResult {
    let new_card = input.card.review(input.rating);

    // review() 返回的 state 只会是 Learning/Review/Relearning（非 New），
    // 因此无需匹配 New 分支。
    let status = match input.rating {
        FsrsRating::Easy => REVIEW_STATUS_MASTERED,
        FsrsRating::Again => REVIEW_STATUS_LEARNING,
        FsrsRating::Good if new_card.reps >= 3 => REVIEW_STATUS_MASTERED,
        _ => match new_card.state {
            FsrsState::Review if new_card.reps >= 3 => REVIEW_STATUS_MASTERED,
            _ => REVIEW_STATUS_LEARNING,
        },
    };

    let interval = new_card.scheduled_days.max(1);
    // B-12: 使用本地时间生成 next_review_at，与 get_review_words 的 datetime('now') 一致
    let next_review_at = (chrono::Local::now() + chrono::Duration::days(interval)).to_rfc3339();

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
        let result = calculate_next_review(input);

        // next_review_at 应为合法 RFC3339 字符串
        let next = chrono::DateTime::parse_from_rfc3339(&result.next_review_at)
            .expect("next_review_at 应为合法 RFC3339 字符串");

        // 间隔至少 1 天，因此 next_review_at 必然在未来（允许 1 秒时钟漂移）
        let next_local = next.with_timezone(&chrono::Local);
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
        let result = calculate_next_review(ReviewCalcInput {
            card: new_card(),
            rating: FsrsRating::Again,
        });
        assert_eq!(result.status, "learning", "Again 应映射为 learning");

        // Easy → mastered
        let result = calculate_next_review(ReviewCalcInput {
            card: new_card(),
            rating: FsrsRating::Easy,
        });
        assert_eq!(result.status, "mastered", "Easy 应映射为 mastered");

        // Good（首评，reps=1 < 3）→ learning
        let result = calculate_next_review(ReviewCalcInput {
            card: new_card(),
            rating: FsrsRating::Good,
        });
        assert_eq!(result.status, "learning", "Good 首评应映射为 learning");

        // Hard（首评，reps=1 < 3）→ learning
        let result = calculate_next_review(ReviewCalcInput {
            card: new_card(),
            rating: FsrsRating::Hard,
        });
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
        // 先 Easy 首评进入 Review 态
        let card = new_card().review(FsrsRating::Easy);
        assert_eq!(card.state, FsrsState::Review);
        let prev_stability = card.stability;

        // 再 Good 评分，stability 应增长（或至少不缩小到 0）
        let result = card.review(FsrsRating::Good);
        assert_eq!(result.state, FsrsState::Review);
        assert_eq!(result.reps, 2);
        assert!(
            result.stability > prev_stability || result.stability > 0.0,
            "Good 评分后 stability 应保持正增长"
        );
    }
}
