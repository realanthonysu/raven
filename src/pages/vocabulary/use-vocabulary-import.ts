/**
 * @module use-vocabulary-import
 * @description CSV/TXT 批量导入生词的自定义 hook。
 *
 * 从 VocabularyPage 抽出：隐藏 file input + 解析导入 + 逐词 LLM 补全，
 * 进度条展示，卸载（cancelledRef）时中断。
 */

import { useCallback, useRef, useState } from "react";
import { type FeedbackType, REVIEW_STATUS, SOURCE_TYPE } from "@/lib/constants";
import { parseCsvLine } from "@/lib/csv-utils";
import { addWord, updateWordEnrichment } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { buildEnrichmentUpdate, isWordLevel, PENDING_DEFINITION } from "@/lib/word-utils";
import { enrichWord } from "@/services/llm";
import type { Word } from "@/types";
import { runBatch } from "./batch-processor";

interface UseVocabularyImportOptions {
  /** 现有单词列表（建立小写查找集合做去重） */
  words: Word[];
  /** 卸载取消标记（与批量补全共享同一 ref） */
  cancelledRef: React.RefObject<boolean>;
  /** 导入结束后的列表刷新 */
  refresh: () => void;
  /** 操作反馈消息 */
  showMessage: (type: FeedbackType, text: string) => void;
}

/**
 * CSV/TXT 导入 hook。返回文件 input ref、导入状态与事件处理器。
 */
export function useVocabularyImport({
  words,
  cancelledRef,
  refresh,
  showMessage,
}: UseVocabularyImportOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  /** 触发隐藏的文件选择器 */
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 解析并导入 CSV/TXT 文件。
   * 支持逗号和 Tab 分隔，支持 RFC 4180 引号字段（如 `"hello, world"`），
   * 首行如果包含 "word" 则跳过表头。
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

        // 跳过表头行
        const startIndex = lines[0]?.toLowerCase().includes("word") ? 1 : 0;
        const dataLines = lines.slice(startIndex);
        if (dataLines.length === 0) {
          showMessage("info", "没有可导入的数据行");
          return;
        }

        setImporting(true);
        setImportProgress({ current: 0, total: dataLines.length });

        let imported = 0;
        let skipped = 0;
        let enrichedCount = 0;

        // 建立现有单词的查找集合（小写）
        const existingSet = new Set(words.map((w) => w.word.toLowerCase()));

        await runBatch({
          items: dataLines,
          isCancelled: () => cancelledRef.current,
          onProgress: (index, total) => setImportProgress({ current: index, total }),
          processItem: async (line) => {
            // 使用 RFC 4180 兼容的解析器，支持引号内逗号（BUG-02 修复）
            const parts = parseCsvLine(line);
            const [word, phonetic, definition, level] = parts;
            if (!word) return true; // 空行：不计数

            // 检查重复（包含本次导入中已添加的词）
            if (existingSet.has(word.toLowerCase())) {
              skipped++;
              return true;
            }

            const hasDefinition = definition && definition !== PENDING_DEFINITION;

            // addWord 返回新插入行的 ID（db_add_word → last_insert_rowid），
            // 用于无释义时回写 LLM 补全结果。抛错由 runBatch 计为失败并继续下一行。
            const insertedId = await addWord({
              word,
              phonetic: phonetic || null,
              definition: definition || PENDING_DEFINITION,
              level: (level && isWordLevel(level) ? level : null) || null,
              source_type: SOURCE_TYPE.import,
              source_text: null,
              notes: null,
              review_status: REVIEW_STATUS.new,
            });

            existingSet.add(word.toLowerCase());
            imported++;

            // 如果没有释义，自动补全（单个补全失败继续）
            if (!hasDefinition) {
              try {
                const enrichedData = await enrichWord(word);
                if (enrichedData && !cancelledRef.current) {
                  await updateWordEnrichment(insertedId, buildEnrichmentUpdate(enrichedData));
                  enrichedCount++;
                }
              } catch {
                // 单个补全失败继续
              }
            }
            return true;
          },
        });

        if (!cancelledRef.current) {
          setImporting(false);
          setImportProgress({ current: 0, total: 0 });
          refresh();

          const summaryParts = [`导入完成：${imported} 个新词`];
          if (skipped > 0) summaryParts.push(`${skipped} 个重复跳过`);
          if (enrichedCount > 0) summaryParts.push(`${enrichedCount} 个已自动补全`);
          showMessage("success", summaryParts.join("，"));
        }
      } catch (err) {
        // 整体兜底：file.text()/解析抛错时 importing 必须复位，
        // 否则导入按钮永久卡在"导入中"（cancelledRef 只覆盖卸载取消路径）
        showMessage("error", `导入失败: ${getErrorMessage(err)}`);
        setImporting(false);
        setImportProgress({ current: 0, total: 0 });
        refresh();
      }
    },
    [words, refresh, showMessage, cancelledRef],
  );

  return { fileInputRef, importing, importProgress, handleImportClick, handleFileChange };
}
