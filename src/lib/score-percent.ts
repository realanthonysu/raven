/**
 * 练习得分的百分制归一 —— 域层纯函数（无 I/O / 无 React，无图表知识）。
 *
 * 听力与练习的落库 score 都是"答对数"而非百分制，估级/趋势等按 0-100
 * 消费的调用方统一走本模块换算，避免把原始分当百分制使用（曾导致听力
 * 估级稳定低一档）。此前的归一化函数住在 lib/analytics（AnalyticsPage 的
 * 图表配色/维度映射 module），估级核心反向依赖呈现层，现归位到独立域模块。
 *
 * 不四舍五入，保留精度；需要整数的调用方自行 Math.round。
 */

/**
 * 将听力"答对句数"归一为百分制。
 *
 * ListeningPage 逐句累加计分（close 记 0.5），落库的 score 是答对句数而非
 * 百分制。
 *
 * @param score - 答对句数（0 - total，可含 0.5）
 * @param total - 总句数
 * @returns 百分制得分；总句数为 0 时返回 null（无有效得分，调用方据此丢弃样本）
 */
export function listeningScorePercent(score: number, total: number): number | null {
  return total > 0 ? (score / total) * 100 : null;
}

/**
 * 将练习"答对题数"归一为百分制。
 *
 * ExercisePage 落库的 score 是答对题数，需除以题数换算为 0-100。
 *
 * @param score - 答对题数（0 - total）
 * @param total - 题目总数
 * @returns 百分制得分；题目总数为 0 时返回 null（无有效得分，调用方据此
 *   丢弃样本或以 0 展示——除零语义与既有内联实现一致）
 */
export function exerciseScorePercent(score: number, total: number): number | null {
  return total > 0 ? (score / total) * 100 : null;
}
