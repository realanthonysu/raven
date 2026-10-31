/**
 * @module batch-processor
 * @description 通用批处理工具函数。
 *
 * 收敛 VocabularyPage 中"批量处理 + 进度回调 + cancelledRef 中断 + 失败计数"
 * 的重复模式（批量补全、CSV 导入共用）。
 */

export interface BatchOptions<T> {
  /** 待处理条目 */
  items: readonly T[];
  /** 返回 true 时中止后续条目（组件卸载/用户取消） */
  isCancelled: () => boolean;
  /**
   * 进度回调：参数为**已完成条数**与总数（成功 + 失败；重复键跳过不计）。
   * 与旧版“条目下标”语义的差异：现在按完成数回调，并发时完成顺序可能乱序。
   */
  onProgress?: (completed: number, total: number) => void;
  /**
   * 处理单个条目。
   * 返回 false 或抛出异常均计为失败（失败不中断批次，继续处理下一条）。
   */
  processItem: (item: T) => Promise<boolean>;
  /** 可选去重键：键重复的条目直接跳过（不计入 completed/failed） */
  getKey?: (item: T) => string | number;
  /**
   * 并发度。默认 1（与旧版严格串行完全兼容）；大于 1 时启动 worker pool。
   * 非法值（0/负数/非有限值）按 1 处理。
   */
  concurrency?: number;
}

export interface BatchResult {
  /** 成功处理的条数（processItem 返回 true） */
  completed: number;
  /** 失败的条数（processItem 返回 false 或抛错） */
  failed: number;
}

/**
 * 批处理执行器：默认逐条串行（concurrency=1），可配置 worker pool 并发。
 *
 * - `isCancelled()` 在每个条目开始前检查；已开始的条目会自然跑完（不强行中断
 *   正在执行的 `processItem`，真正的请求取消由调用方通过 AbortSignal 传递）。
 * - 单个条目失败（返回 false / 抛错）继续处理下一个。
 * - `onProgress` 按**完成条数**回调，且只在成功/失败计入后触发；重复 getKey
 *   跳过的条目不产生进度回调。
 */
export async function runBatch<T>({
  items,
  isCancelled,
  onProgress,
  processItem,
  getKey,
  concurrency: requestedConcurrency = 1,
}: BatchOptions<T>): Promise<BatchResult> {
  const processedKeys = new Set<string | number>();
  let completed = 0;
  let failed = 0;
  let finished = 0;
  let nextIndex = 0;

  const concurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : 1;
  const workerCount = Math.min(concurrency, items.length);

  async function worker(): Promise<void> {
    while (true) {
      if (isCancelled()) return;

      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index];
      if (getKey) {
        const key = getKey(item);
        if (processedKeys.has(key)) continue;
        processedKeys.add(key);
      }

      let succeeded = false;
      try {
        succeeded = await processItem(item);
      } catch {
        // 单个失败继续处理下一个
        succeeded = false;
      }

      if (succeeded) {
        completed += 1;
      } else {
        failed += 1;
      }
      finished += 1;
      onProgress?.(finished, items.length);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { completed, failed };
}
