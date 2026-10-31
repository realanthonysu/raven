/**
 * @module use-batch-runner
 * @description 批量任务运行骨架 hook：running/progress 状态 + 取消感知的
 * 顺序批处理执行 + 结束复位。
 *
 * VocabularyPage 的批量补全（use-batch-enrich）与 CSV 导入
 * （use-vocabulary-import）共用同一套「运行中标记 + 进度 + cancelledRef
 * 中断 + 失败计数」骨架，区别只在 processItem 的业务判定与收尾消息。
 * 本 hook 收敛状态层，循环层由 batch-processor 的 runBatch 承担。
 *
 * 边界：runner 不调用 refresh/showMessage——收尾消息由调用方在
 * `!cancelledRef.current` 时负责，保持「卸载后不刷新/不提示」的语义；
 * 防并发入口（两个批次按钮互斥禁用）由页面层负责。
 */

import { useCallback, useState } from "react";
import { runBatch } from "./batch-processor";

/** 批次进度：当前条目下标与总数 */
export interface BatchProgress {
  current: number;
  total: number;
}

/** 批次汇总：成功与失败的条目数 */
export interface BatchSummary {
  completed: number;
  failed: number;
}

/** run 的可选项：取消判定、可选去重键与单条处理逻辑（语义同 BatchOptions） */
export interface BatchRunOptions<I> {
  /** 返回 true 时中止后续条目（组件卸载取消） */
  isCancelled: () => boolean;
  /** 可选去重键：键重复的条目直接跳过（不计入 completed/failed） */
  getKey?: (item: I) => number | string;
  /**
   * 处理单个条目。
   * 返回 false 或抛出异常均计为失败（失败不中断批次，继续处理下一条）。
   */
  processItem: (item: I) => Promise<boolean>;
  /** 并发度；不传时 runBatch 默认 1，保持旧行为完全兼容。 */
  concurrency?: number;
}

/**
 * 批量任务运行骨架。返回运行状态、进度与执行函数。
 *
 * - `run` 负责 running 置位、进度回传与 finally 复位（含异常路径）；
 * - 卸载取消同样走 finally：卸载后 setState 为 no-op（React 18+ 不再告警），
 *   与「不主动复位」的原实现语义一致；
 * - `reset` 供调用方在 run 之外的错误路径（如 file.text() / getWords() 抛错、
 *   批次尚未启动）主动复位。
 */
export function useBatchRunner(): {
  running: boolean;
  progress: BatchProgress;
  run: <I>(items: I[], options: BatchRunOptions<I>) => Promise<BatchSummary>;
  reset: () => void;
} {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress>({ current: 0, total: 0 });

  const run = useCallback(
    async <I>(items: I[], options: BatchRunOptions<I>): Promise<BatchSummary> => {
      setRunning(true);
      setProgress({ current: 0, total: items.length });
      try {
        return await runBatch({
          items,
          isCancelled: options.isCancelled,
          getKey: options.getKey,
          onProgress: (completed, total) => setProgress({ current: completed, total }),
          processItem: options.processItem,
          concurrency: options.concurrency,
        });
      } finally {
        // 卸载取消时同样执行：卸载后 setState 无意义（no-op），语义不变
        setRunning(false);
        setProgress({ current: 0, total: 0 });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setRunning(false);
    setProgress({ current: 0, total: 0 });
  }, []);

  return { running, progress, run, reset };
}
