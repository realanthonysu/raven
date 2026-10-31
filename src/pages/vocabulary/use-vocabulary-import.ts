/**
 * @module use-vocabulary-import
 * @description CSV/TXT 批量导入生词的自定义 hook。
 *
 * 从 VocabularyPage 抽出：隐藏 file input + 解析导入 + 批量插入 + 逐词 LLM 补全，
 * 进度条展示，卸载（cancelledRef）时中断。
 * 运行骨架（running/progress/复位）复用 use-batch-runner。
 *
 * 性能约定（D-03/H-11）：不再读取全量 getWords() 作为去重基线——解析后的行按
 * IMPORT_BATCH_SIZE 分块调用 `addWordsBatch`（Rust 单事务插入），以每条返回的
 * `inserted` 判重（false → skipped）、`error` 计入失败，避免逐行 IPC。
 */

import { useCallback, useRef } from "react";
import { type FeedbackType, SOURCE_TYPE } from "@/lib/constants";
import { parseCsvLine } from "@/lib/csv-utils";
import { addWordsBatch, updateWordEnrichment } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  buildEnrichmentUpdate,
  buildNewWordInput,
  hasUsableEnrichment,
  PENDING_DEFINITION,
} from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import { useBatchRunner } from "./use-batch-runner";

/** 单次 addWordsBatch 的最大行数：Rust 侧单事务插入，块过大时事务持锁时间增长 */
const IMPORT_BATCH_SIZE = 50;

interface UseVocabularyImportOptions {
  /** 卸载取消标记（与批量补全共享同一 ref） */
  cancelledRef: React.RefObject<boolean>;
  /** 导入结束后的列表刷新 */
  refresh: () => void;
  /** 操作反馈消息 */
  showMessage: (type: FeedbackType, text: string) => void;
}

/** 解析后的一行导入数据（空行已剔除） */
interface ImportRow {
  word: string;
  phonetic: string;
  definition: string;
  level: string;
  /** 是否带可用释义：无释义才在批量插入后调用 LLM 补全 */
  hasDefinition: boolean;
}

/** 把数组按固定大小切块（最后一块可短） */
function chunkRows<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * CSV/TXT 导入 hook。返回文件 input ref、导入状态与事件处理器。
 */
export function useVocabularyImport({
  cancelledRef,
  refresh,
  showMessage,
}: UseVocabularyImportOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { running: importing, progress: importProgress, run, reset } = useBatchRunner();

  /** 触发隐藏的文件选择器 */
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 解析并导入 CSV/TXT 文件。
   * 支持逗号和 Tab 分隔，支持 RFC 4180 引号字段（如 `"hello, world"`），
   * 首行第一个字段精确等于 "word"（大小写不敏感）时跳过表头。
   */
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // 重置 file input 以便重复选择同一文件
      e.target.value = "";

      cancelledRef.current = false;
      try {
        const text = await file.text();
        const lines = text.split("\n").filter((line) => line.trim());
        if (lines.length === 0) {
          showMessage("info", "文件为空");
          return;
        }

        // 跳过表头行：只看首个字段是否精确等于 "word"。
        // 整行 includes("word") 会把 "sword,/sɔːd/,n. 剑" 这类首行数据
        // 误判为表头而整行丢弃
        const firstField = parseCsvLine(lines[0])[0]?.trim().toLowerCase();
        const startIndex = firstField === "word" ? 1 : 0;
        const dataLines = lines.slice(startIndex);
        if (dataLines.length === 0) {
          showMessage("info", "没有可导入的数据行");
          return;
        }

        const rows: ImportRow[] = [];
        for (const line of dataLines) {
          const [word, phonetic, definition, level] = parseCsvLine(line);
          if (!word) continue; // 空行：不计数
          const hasDefinition = Boolean(definition && definition !== PENDING_DEFINITION);
          rows.push({
            word,
            phonetic: phonetic || "",
            definition: definition || "",
            level: level || "",
            hasDefinition,
          });
        }
        if (rows.length === 0) {
          showMessage("info", "没有可导入的数据行");
          return;
        }

        let imported = 0;
        let skipped = 0;
        let enrichedCount = 0;
        let enrichFailed = 0;
        /** 批量命令按条返回的失败数（与 runner 的块级失败分开累计） */
        let rowFailed = 0;

        // 分块批量插入：每块一次 IPC（Rust 单事务），结果数组与 inputs 按下标对齐
        const chunks = chunkRows(rows, IMPORT_BATCH_SIZE);
        await run(chunks, {
          isCancelled: () => cancelledRef.current,
          processItem: async (chunk) => {
            const inputs = chunk.map((row) =>
              buildNewWordInput({
                word: row.word,
                phonetic: row.phonetic || null,
                definition: row.definition || PENDING_DEFINITION,
                level: row.level,
                source_type: SOURCE_TYPE.import,
                source_text: null,
                notes: null,
              }),
            );

            let results: Awaited<ReturnType<typeof addWordsBatch>>;
            try {
              results = await addWordsBatch(inputs);
            } catch {
              // 整块失败：块内所有行计入失败，继续下一块（runBatch 的失败语义）
              rowFailed += chunk.length;
              return true;
            }

            if (cancelledRef.current) return true;

            // 批量插入成功后，缺释义的已插入条目再逐词补全（保持原串行语义）
            const enrichTargets: Array<{ row: ImportRow; id: number }> = [];
            for (let i = 0; i < chunk.length; i++) {
              const result = results[i];
              const row = chunk[i];
              if (!result || result.error) {
                rowFailed++;
                continue;
              }
              if (!result.inserted) {
                // 已存在（含同文件内重复行，由后端 lower(word) 唯一索引判定）
                skipped++;
                continue;
              }
              imported++;
              if (!row.hasDefinition && result.id !== null) {
                enrichTargets.push({ row, id: result.id });
              }
            }

            for (const target of enrichTargets) {
              if (cancelledRef.current) break;
              try {
                const enrichedData = await enrichWord(target.row.word);
                if (cancelledRef.current) break;
                // 补全结果任一核心字段为空视为失败：空 phonetic 会经
                // buildEnrichmentUpdate 写成空串、覆盖刚插入行的音标，
                // 空 definition 则越补越空——不写库，计一次补全失败（E5）
                if (enrichedData && hasUsableEnrichment(enrichedData)) {
                  await updateWordEnrichment(target.id, buildEnrichmentUpdate(enrichedData));
                  enrichedCount++;
                } else {
                  enrichFailed++;
                }
              } catch {
                // 防御性：enrichWord 契约上返回 null，但若未来抛错也计入补全失败
                if (!cancelledRef.current) enrichFailed++;
              }
            }
            return true;
          },
        });

        if (!cancelledRef.current) {
          refresh();

          const summaryParts = [`导入完成：${imported} 个新词`];
          if (skipped > 0) summaryParts.push(`${skipped} 个重复跳过`);
          if (enrichedCount > 0) summaryParts.push(`${enrichedCount} 个已自动补全`);
          if (enrichFailed > 0) summaryParts.push(`${enrichFailed} 个补全失败（可重试）`);
          if (rowFailed > 0) summaryParts.push(`${rowFailed} 个失败（可重试）`);
          showMessage(
            rowFailed > 0 || enrichFailed > 0 ? "info" : "success",
            summaryParts.join("，"),
          );
        }
      } catch (err) {
        // 整体兜底：file.text()/解析抛错时 importing 必须复位，
        // 否则导入按钮永久卡在"导入中"（cancelledRef 只覆盖卸载取消路径）
        showMessage("error", `导入失败: ${getErrorMessage(err)}`);
        reset();
        refresh();
      }
    },
    [run, reset, refresh, showMessage, cancelledRef],
  );

  // 返回 API 保持稳定：页面与测试按 importing / importProgress 消费
  return { fileInputRef, importing, importProgress, handleImportClick, handleFileChange };
}
