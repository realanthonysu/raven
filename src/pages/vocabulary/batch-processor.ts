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
  /** 返回 true 时中止后续条目（组件卸载取消） */
  isCancelled: () => boolean;
  /** 每个条目处理前的进度回调（参数为当前条目下标与总数） */
  onProgress?: (index: number, total: number) => void;
  /**
   * 处理单个条目。
   * 返回 false 或抛出异常均计为失败（失败不中断批次，继续处理下一条）。
   */
  processItem: (item: T) => Promise<boolean>;
  /** 可选去重键：键重复的条目直接跳过（不计入 completed/failed） */
  getKey?: (item: T) => string | number;
}

export interface BatchResult {
  /** 成功处理的条数（processItem 返回 true） */
  completed: number;
  /** 失败的条数（processItem 返回 false 或抛错） */
  failed: number;
}

/**
 * 顺序批处理：逐条执行 processItem，每条前触发 onProgress，
 * isCancelled() 为 true 时停止。单个条目失败（返回 false / 抛错）继续下一条。
 */
export async function runBatch<T>({
  items,
  isCancelled,
  onProgress,
  processItem,
  getKey,
}: BatchOptions<T>): Promise<BatchResult> {
  const processedKeys = new Set<string | number>();
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (isCancelled()) break;

    const item = items[i];
    if (getKey) {
      const key = getKey(item);
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);
    }

    onProgress?.(i, items.length);
    try {
      if (await processItem(item)) {
        completed++;
      } else {
        failed++;
      }
    } catch {
      // 单个失败继续处理下一个
      failed++;
    }
  }

  return { completed, failed };
}
