/**
 * @module use-vocabulary-import
 * @description CSV/TXT 批量导入生词的自定义 hook。
 *
 * 从 VocabularyPage 抽出：隐藏 file input + 解析导入 + 逐词 LLM 补全，
 * 进度条展示，卸载（cancelledRef）时中断。
 * 运行骨架（running/progress/复位）复用 use-batch-runner。
 */

import { useCallback, useRef } from "react";
import { type FeedbackType, SOURCE_TYPE } from "@/lib/constants";
import { parseCsvLine } from "@/lib/csv-utils";
import { addWord, getWords, updateWordEnrichment } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  asciiLower,
  buildEnrichmentUpdate,
  buildNewWordInput,
  hasUsableEnrichment,
  PENDING_DEFINITION,
} from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import { useBatchRunner } from "./use-batch-runner";

interface UseVocabularyImportOptions {
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

        let imported = 0;
        let skipped = 0;
        let enrichedCount = 0;
        let enrichFailed = 0;

        // 去重基线必须来自一次全量 getWords()：页面当前 words 可能只是搜索
        // 结果的子集，拿它建集合会把搜索窗口外的已有词当成新词重复插入。
        // 全量读取失败则中止导入——用子集兜底会静默产生重复行。
        let existingSet: Set<string>;
        try {
          const allWords = await getWords();
          existingSet = new Set(allWords.map((w) => asciiLower(w.word)));
        } catch (err) {
          // 批次尚未启动，reset 为防御性复位（running 本就为 false）
          reset();
          showMessage("error", `导入失败: ${getErrorMessage(err)}`);
          return;
        }

        const { failed } = await run(dataLines, {
          isCancelled: () => cancelledRef.current,
          processItem: async (line) => {
            // 使用 RFC 4180 兼容的解析器，支持引号内逗号（BUG-02 修复）
            const parts = parseCsvLine(line);
            const [word, phonetic, definition, level] = parts;
            if (!word) return true; // 空行：不计数

            // 已存在于词库（含本次导入中已添加的词）：计入 skipped，
            // 不调用 addWord / updateWordEnrichment，避免覆盖旧富化数据
            if (existingSet.has(asciiLower(word))) {
              skipped++;
              return true;
            }

            const hasDefinition = definition && definition !== PENDING_DEFINITION;

            // addWord 返回新插入行的 ID（db_add_word → last_insert_rowid），
            // 用于无释义时回写 LLM 补全结果。抛错由 runBatch 计为失败并继续下一行。
            // level 的合法性归一（非法值 → null）由 buildNewWordInput 内的
            // toWordLevel 负责，CSV 列同样属不可信来源。
            const insertedId = await addWord(
              buildNewWordInput({
                word,
                phonetic: phonetic || null,
                definition: definition || PENDING_DEFINITION,
                level,
                source_type: SOURCE_TYPE.import,
                source_text: null,
                notes: null,
              }),
            );

            existingSet.add(asciiLower(word));
            imported++;

            // 如果没有释义，自动补全（单个补全失败继续）
            if (!hasDefinition) {
              try {
                const enrichedData = await enrichWord(word);
                if (cancelledRef.current) return true;
                // 补全结果任一核心字段为空视为失败：空 phonetic 会经
                // buildEnrichmentUpdate 写成空串、覆盖刚插入行的音标，
                // 空 definition 则越补越空——不写库，计一次补全失败（E5）
                if (enrichedData && hasUsableEnrichment(enrichedData)) {
                  await updateWordEnrichment(insertedId, buildEnrichmentUpdate(enrichedData));
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
          if (failed > 0) summaryParts.push(`${failed} 个失败（可重试）`);
          showMessage(failed > 0 || enrichFailed > 0 ? "info" : "success", summaryParts.join("，"));
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
