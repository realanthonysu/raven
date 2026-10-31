/**
 * useHistoryWindow —— Analytics 数据窗口的单一 owner（加载 + 守卫 + 窗口旗标）。
 *
 * 收敛此前两处手写的同一套加载脚手架（use-analytics/index.ts 与
 * use-level-estimation.ts 各自包一遍 getHistoryWithResults + stale 守卫 +
 * fail-soft 错误 + reload 令牌 + resultsWindowLimited 手抄）：
 * 本 hook 持有「六类元数据 + 五类 result」的完整窗口协议：
 * - 类型口径：lib/level-estimation-samples 的 LEVEL_ESTIMATE_RECORD_TYPES /
 *   LEVEL_ESTIMATE_RESULT_TYPES（reading 只取元数据、不拉重型 Markdown result）；
 * - 窗口条数：lib/db/history 的 HISTORY_RECORD_LIMIT(500) / HISTORY_RESULT_LIMIT(150)
 *   （元数据窗口 500 条覆盖近期会话/类型计数，重型 result 只拉最近 150 条压低
 *   Tauri IPC 载荷与主线程 Zod 校验量；更老的记录无 result 时解析方自动跳过，
 *   时间轴上的元数据统计不受影响）。
 *
 * 语义（沿用两个 loader 的原约定）：
 * - fail-soft：加载失败不抛错，错误信息经 error 字段暴露（调用方渲染错误态 +
 *   重试入口，不得让失败伪装成"数据不足"的空态）；
 * - stale 守卫：reload 连点 / 卸载时丢弃过期响应，慢的旧加载不覆盖新状态；
 * - resultsWindowLimited：resultById.size >= HISTORY_RESULT_LIMIT 即视为可能
 *   截断（恰为上限时无法区分是否还有更多），只在此处计算一次，UI 披露文案
 *   的不变量由代码持有而非两处手抄。
 *
 * 消费方只做自己的派生逻辑：use-analytics 编排层（解析/时间范围过滤/子 hook
 * 派发）与 use-level-estimation（被动估计归一化）。
 *
 * 窗口可配置：默认沿用 HISTORY_RECORD_LIMIT(500) / HISTORY_RESULT_LIMIT(150)，
 * 调用方可传更小的窗口（如 LevelCard 被动估计只需近期样本，见
 * use-level-estimation 的 LEVEL_ESTIMATION_* 常量）。`resultsWindowLimited`
 * 始终以「本次请求的 resultLimit」为比较基准，而不是全局默认值。
 */

import { useCallback, useEffect, useState } from "react";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { getHistoryWithResults, HISTORY_RECORD_LIMIT, HISTORY_RESULT_LIMIT } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  LEVEL_ESTIMATE_RECORD_TYPES,
  LEVEL_ESTIMATE_RESULT_TYPES,
} from "@/lib/level-estimation-samples";
import type { HistoryRecord } from "@/types";

/** useHistoryWindow 的返回结构 —— 窗口数据与加载状态。 */
export interface HistoryWindowState {
  /** 是否正在加载历史记录 */
  loading: boolean;
  /** 加载失败的错误信息（null 表示无错误）；失败时调用方应渲染错误态而非空态 */
  error: string | null;
  /** 重新拉取（错误态重试入口 / 数据刷新） */
  reload: () => void;
  /** 轻量历史记录（六类，created_at 降序；时间语义必须基于 created_at 推导） */
  records: HistoryRecord[];
  /** 记录 id → result 原始字符串（必须按 id 取用，勿按下标配对） */
  resultById: Map<number, string>;
  /** result 窗口是否被本次请求的 resultLimit 截断（取满上限即视为可能截断） */
  resultsWindowLimited: boolean;
}

/** useHistoryWindow 的窗口覆盖项（省略时沿用 lib/db/history 的默认 500/150）。 */
export interface UseHistoryWindowOptions {
  /** 轻量元数据窗口条数；默认 HISTORY_RECORD_LIMIT */
  recordLimit?: number;
  /** 重型 result 窗口条数；默认 HISTORY_RESULT_LIMIT，同时作为截断标志的比较基准 */
  resultLimit?: number;
}

/**
 * 拉取并持有 Analytics 数据窗口（单次 getHistoryWithResults）。
 *
 * @param options - 可选的窗口覆盖（recordLimit / resultLimit）；不传时保持默认协议
 * @returns 窗口数据（records / resultById / resultsWindowLimited）与加载三态
 */
export function useHistoryWindow(options?: UseHistoryWindowOptions): HistoryWindowState {
  const recordLimit = options?.recordLimit ?? HISTORY_RECORD_LIMIT;
  const resultLimit = options?.resultLimit ?? HISTORY_RESULT_LIMIT;

  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [resultById, setResultById] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // 乱序响应守卫：reload() 连点、错误态重试与挂载加载可能交错，慢的旧响应
  // 不允许覆盖新结果（机制文档归 useStaleGuard 所有）
  const { begin, isStale } = useStaleGuard();

  useEffect(() => {
    const seq = begin();
    // reloadToken 是重触发令牌：值本身不参与数据逻辑（引用以满足依赖分析），
    // reload() 递增令牌使本 effect 重新执行数据加载
    void reloadToken;
    setError(null);
    getHistoryWithResults(
      LEVEL_ESTIMATE_RECORD_TYPES,
      recordLimit,
      LEVEL_ESTIMATE_RESULT_TYPES,
      resultLimit,
    )
      .then(({ records: recs, resultById: byId }) => {
        if (isStale(seq)) return;
        setRecords(recs);
        setResultById(byId);
        setLoading(false);
      })
      .catch((err) => {
        if (isStale(seq)) return;
        console.warn("useHistoryWindow: getHistoryWithResults failed", err);
        // 失败不抛错（页面不白屏），但错误必须可见：调用方渲染错误横幅 + 重试
        setError(getErrorMessage(err, "历史记录加载失败"));
        setLoading(false);
      });
    return () => {
      // useStaleGuard 无 cleanup：重触发/卸载时主动 begin() 使在途响应过期，
      // 迟到的响应/拒绝不写状态也不打日志
      begin();
    };
  }, [reloadToken, begin, isStale, recordLimit, resultLimit]);

  // result 窗口截断标志：取到的 result 数达到本次请求的 resultLimit 即视为可能
  // 截断；result 数为 0（含查询失败降级）时自然为 false。窗口协议的唯一计算处。
  const resultsWindowLimited = resultById.size >= resultLimit;

  // useCallback 固定身份：消费方（use-analytics 的整体 memo）可把它安全列入依赖，
  // 不会因每次渲染的新箭头引用使下游 memoization 失效
  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return {
    loading,
    error,
    reload,
    records,
    resultById,
    resultsWindowLimited,
  };
}
