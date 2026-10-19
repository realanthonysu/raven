/**
 * @module use-batch-enrich
 * @description 批量补全缺失数据的单词的自定义 hook。
 *
 * 从 VocabularyPage 抽出：逐个调用 enrichWord，进度条展示，
 * 卸载（cancelledRef）时中断，失败条目计数后由调用方汇总提示。
 */

import { useCallback, useState } from "react";
import { updateWordEnrichment } from "@/lib/db";
import { buildEnrichmentUpdate, needsEnrichment } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import type { EnrichedWord, Word } from "@/types";
import { runBatch } from "./batch-processor";

/**
 * 补全结果可用性校验：音标与释义去空白后必须均非空。
 *
 * LLM 偶发返回空字段：空 phonetic 经 buildEnrichmentUpdate 会写成空串、
 * 覆盖词库中原有音标，空 definition 则把"待补充"越补越空。故任一为空
 * 即视为补全失败——不写库、计失败，保留原数据交由用户重试。
 * 单个补全、批量补全与 CSV 导入补全三条路径共用此判定。
 */
export function hasUsableEnrichment(enriched: EnrichedWord): boolean {
  return enriched.phonetic.trim() !== "" && enriched.definition.trim() !== "";
}

interface UseBatchEnrichOptions {
  /** 当前单词列表（筛选出缺失数据的条目进行补全） */
  words: Word[];
  /** 卸载取消标记（与 CSV 导入共享同一 ref） */
  cancelledRef: React.RefObject<boolean>;
  /** 批次结束后的列表刷新 */
  refresh: () => void;
  /** 操作反馈消息 */
  showMessage: (type: "success" | "info" | "error", text: string) => void;
}

/**
 * 批量补全 hook。返回批处理状态与触发函数。
 *
 * 行为说明：组件卸载中断时不复位 batchEnriching（与原实现一致——
 * 卸载后 setState 无意义），仅在正常结束时复位并汇总消息。
 */
export function useBatchEnrich({
  words,
  cancelledRef,
  refresh,
  showMessage,
}: UseBatchEnrichOptions) {
  const [batchEnriching, setBatchEnriching] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  /**
   * 批量补全所有缺失数据的单词。
   * 逐个处理，每完成一个更新进度条。组件卸载时自动中止。
   * 失败条目计数并在结束后汇总提示（此前单个失败被静默吞掉，用户看到的是"全成功"）。
   */
  const handleBatchEnrich = useCallback(async () => {
    const toEnrich = words.filter(needsEnrichment);
    if (toEnrich.length === 0) return;

    cancelledRef.current = false;
    setBatchEnriching(true);
    setBatchProgress({ current: 0, total: toEnrich.length });

    const { completed, failed } = await runBatch({
      items: toEnrich,
      isCancelled: () => cancelledRef.current,
      onProgress: (index, total) => setBatchProgress({ current: index, total }),
      getKey: (word) => word.id,
      processItem: async (word) => {
        const enriched = await enrichWord(word.word);
        // 空字段补全视为失败：写库会清空原音标/释义并误报成功（E5）
        if (enriched && !cancelledRef.current && hasUsableEnrichment(enriched)) {
          await updateWordEnrichment(word.id, buildEnrichmentUpdate(enriched));
          return true;
        }
        return false;
      },
    });

    if (!cancelledRef.current) {
      setBatchEnriching(false);
      setBatchProgress({ current: 0, total: 0 });
      refresh();

      const parts = [`批量补全完成：${completed} 个成功`];
      if (failed > 0) parts.push(`${failed} 个失败（可重试）`);
      showMessage(failed > 0 ? "info" : "success", parts.join("，"));
    }
  }, [words, refresh, showMessage, cancelledRef]);

  return { batchEnriching, batchProgress, handleBatchEnrich };
}
