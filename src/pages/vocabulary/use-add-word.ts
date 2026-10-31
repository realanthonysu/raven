/**
 * @module use-add-word
 * @description 手动添加单词（含 LLM 释义补全）的自定义 hook。从 VocabularyPage 抽出。
 */

import { useCallback, useState } from "react";
import { type FeedbackType, SOURCE_TYPE } from "@/lib/constants";
import { addWord, wordExists } from "@/lib/db";
import { buildEnrichmentNotes, buildNewWordInput, PENDING_DEFINITION } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";

interface UseAddWordOptions {
  /** 添加成功后的列表刷新 */
  refresh: () => void;
  /** 操作反馈消息 */
  showMessage: (type: FeedbackType, text: string) => void;
}

/**
 * 手动添加单词 hook。
 *
 * 如果用户未填写释义，自动调用 enrichWord 补全。
 * 返回表单受控状态、提交状态与提交函数（表单清空由 hook 内完成）。
 */
export function useAddWord({ refresh, showMessage }: UseAddWordOptions) {
  const [formOpen, setFormOpen] = useState(false);
  const [formWord, setFormWord] = useState("");
  const [formPhonetic, setFormPhonetic] = useState("");
  const [formDefinition, setFormDefinition] = useState("");
  const [formLevel, setFormLevel] = useState<string>("");
  const [adding, setAdding] = useState(false);

  /**
   * 手动添加单词。
   * 如果用户未填写释义，自动调用 enrichWord 补全。
   */
  const handleAddWord = useCallback(async () => {
    const wordText = formWord.trim();
    if (!wordText) return;

    // —— 词库存在性预检（D-05）——
    // 不再拉取最多 500 条 WordDto 再在前端做精确比对：存在性只需一个布尔值，
    // db_word_exists 走 lower(word) 唯一索引等值查询，返回值不带词条内容，
    // 也不会像模糊 LIKE 那样把"搜索有结果"误当成"已存在"。大小写不敏感语义
    // 由 SQL（lower(word) = lower(?1)）统一保证，与 add_word 的幂等判定一致。
    let exists = false;
    try {
      exists = await wordExists(wordText);
    } catch (err) {
      // 预检失败按未命中处理，退回完整流程（后端 add_word 幂等兜底）
      console.warn("Vocabulary existence precheck failed:", err);
    }
    if (exists) {
      showMessage("info", `"${wordText}" 已存在于生词本中，未重复添加`);
      return;
    }

    setAdding(true);
    try {
      let phonetic = formPhonetic.trim() || null;
      let definition = formDefinition.trim() || PENDING_DEFINITION;
      let notes: string | null = null;

      // 如果用户没有填写释义，调用 LLM 补全
      if (!formDefinition.trim()) {
        const enriched = await enrichWord(wordText);
        if (enriched) {
          phonetic = enriched.phonetic || phonetic;
          definition = enriched.definition || definition;
          notes = buildEnrichmentNotes(enriched);
        }
      }

      await addWord(
        buildNewWordInput({
          word: wordText,
          phonetic,
          definition,
          level: formLevel,
          source_type: SOURCE_TYPE.manual,
          source_text: null,
          notes,
        }),
      );

      // 清空表单
      setFormWord("");
      setFormPhonetic("");
      setFormDefinition("");
      setFormLevel("");
      refresh();
      showMessage("success", `已添加 "${wordText}"`);
    } catch {
      showMessage("error", "添加失败，请重试");
    } finally {
      setAdding(false);
    }
  }, [formWord, formPhonetic, formDefinition, formLevel, showMessage, refresh]);

  return {
    formOpen,
    setFormOpen,
    formWord,
    setFormWord,
    formPhonetic,
    setFormPhonetic,
    formDefinition,
    setFormDefinition,
    formLevel,
    setFormLevel,
    adding,
    handleAddWord,
  };
}
