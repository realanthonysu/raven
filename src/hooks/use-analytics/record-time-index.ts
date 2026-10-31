/**
 * 记录时间索引（H-02）—— 同一条历史记录的 created_at 只解析一次。
 *
 * 编排层与各子 hook 原先在每次派生计算里重复调用 `parseDbTimestamp`
 * （排序比较器里每次比较都要 `new Date`；切换时间范围(days)时所有子 hook 的
 * useMemo 全部失效、重跑 5 次以上排序，产生数千次 Date 构造与本地化格式化）。
 *
 * 本模块把「记录 id → 毫秒时间戳 / 图表日期标签 / 完整日期」的解析结果放进
 * Map 缓存：编排层基于全量记录构建一次索引下发，子 hook 只读索引，切换时间
 * 范围时只做数值比较，不再重复解析。日期标签按需格式化并按记录缓存，
 * 避免为未被展示的记录付 `toLocaleDateString` 的代价。
 */
import { parseDbTimestamp } from "@/lib/db";
import type { HistoryRecord } from "@/types";

/** 图表 X 轴日期标签（与既有 `toLocaleDateString("zh-CN", { month:"short", day:"numeric" })` 同口径） */
const CHART_DATE_OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/**
 * 记录时间索引：所有方法都按记录 id 缓存，重复调用不重复解析。
 *
 * 索引未命中时（例如子 hook 测试直接构造记录、不传索引）回退到实时解析，
 * 并把结果写入索引缓存，保证行为与未使用索引时一致。
 */
export interface RecordTimeIndex {
  /** 记录的 created_at 毫秒时间戳（解析一次后缓存） */
  timeOf(record: HistoryRecord): number;
  /** 图表 X 轴日期标签（"7月1日" 形式，按记录缓存） */
  chartDateOf(record: HistoryRecord): string;
  /** 完整本地日期（近期会话列表用，按记录缓存） */
  fullDateOf(record: HistoryRecord): string;
}

/**
 * 基于给定的历史记录构建时间索引。
 *
 * 只在这里对每条记录调用一次 `parseDbTimestamp`；日期格式化延迟到首次
 * 读取某条记录的标签时进行，并写入同一索引的缓存。
 *
 * @param records - 轻量历史记录（通常为编排层一次查询返回的全窗口 500 条）
 */
export function createRecordTimeIndex(records: HistoryRecord[]): RecordTimeIndex {
  const times = new Map<number, number>();
  const chartDates = new Map<number, string>();
  const fullDates = new Map<number, string>();

  for (const record of records) {
    times.set(record.id, parseDbTimestamp(record.created_at).getTime());
  }

  const timeOf = (record: HistoryRecord): number => {
    const cached = times.get(record.id);
    if (cached !== undefined) return cached;
    const parsed = parseDbTimestamp(record.created_at).getTime();
    times.set(record.id, parsed);
    return parsed;
  };

  const chartDateOf = (record: HistoryRecord): string => {
    const cached = chartDates.get(record.id);
    if (cached !== undefined) return cached;
    const label = new Date(timeOf(record)).toLocaleDateString("zh-CN", CHART_DATE_OPTIONS);
    chartDates.set(record.id, label);
    return label;
  };

  const fullDateOf = (record: HistoryRecord): string => {
    const cached = fullDates.get(record.id);
    if (cached !== undefined) return cached;
    const label = new Date(timeOf(record)).toLocaleDateString("zh-CN");
    fullDates.set(record.id, label);
    return label;
  };

  return { timeOf, chartDateOf, fullDateOf };
}
