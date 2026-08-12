//! FSRS 间隔重复算法 Tauri Command。
//!
//! 提供以下前端可调用的 Command：
//! - `db_calculate_and_update_review` - 原子操作：计算 + 更新（H-3 修复）

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::fsrs;
use crate::repository::traits::WriteRepository;

use super::shared::with_db;

/// 原子操作：计算 FSRS 下次复习参数并立即更新数据库（H-3 修复）。
///
/// 将 FSRS 调度计算（calculate_next_review_with_retention）和单词复习状态更新
/// 合并为单一 Command，消除前端两步调用之间的崩溃窗口和部分成功状态不一致问题。
///
/// # Arguments
///
/// * `id` - 单词 ID
/// * `card` - 当前 FSRS 卡片状态
/// * `rating` - 用户评分（again / hard / good / easy）
///
/// # Returns
///
/// FSRS 调度结果：学习状态标签、间隔天数、下次复习时间和更新后卡片状态。
#[tauri::command]
pub async fn db_calculate_and_update_review(
    db: State<'_, Db>,
    id: i64,
    card: fsrs::FsrsCard,
    rating: fsrs::FsrsRating,
) -> Result<fsrs::ReviewCalcResult, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        conn.calculate_and_update_review(id, &card, rating)
    })
}
