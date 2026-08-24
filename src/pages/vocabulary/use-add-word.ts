/**
 * @module use-add-word
 * @description 手动添加单词（含 LLM 释义补全）的自定义 hook。从 VocabularyPage 抽出。
 */

import { useCallback, useState } from "react";
import { type FeedbackType, REVIEW_STATUS, SOURCE_TYPE } from "@/lib/constants";
import { addWord } from "@/lib/db";
import { buildEnrichmentNotes, isWordLevel, PENDING_DEFINITION } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import type { Word } from "@/types";

interface UseAddWordOptions {
  /** 现有单词列表（重复检查） */
  words: Word[];
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
export function useAddWord({ words, refresh, showMessage }: UseAddWordOptions) {
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

    // 检查重复
    if (words.some((w) => w.word.toLowerCase() === wordText.toLowerCase())) {
      showMessage("info", `"${wordText}" 已存在于生词本中`);
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

      await addWord({
        word: wordText,
        phonetic,
        definition,
        level: (formLevel && isWordLevel(formLevel) ? formLevel : null) || null,
        source_type: SOURCE_TYPE.manual,
        source_text: null,
        notes,
        review_status: REVIEW_STATUS.new,
      });

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
  }, [formWord, formPhonetic, formDefinition, formLevel, words, showMessage, refresh]);

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
