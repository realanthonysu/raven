/**
 * @module use-add-word
 * @description 手动添加单词（含 LLM 释义补全）的自定义 hook。从 VocabularyPage 抽出。
 */

import { useCallback, useState } from "react";
import { type FeedbackType, REVIEW_STATUS, SOURCE_TYPE } from "@/lib/constants";
import { addWord, getWords } from "@/lib/db";
import { buildEnrichmentNotes, isWordLevel, PENDING_DEFINITION } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import type { Word } from "@/types";

/** 与 SQLite lower() 的 ASCII 语义对齐：仅折叠 A-Z，不改写非 ASCII 字符。 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

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

    // —— 词库存在性预检 ——
    // 不再用页面 words 快照判重：搜索态下快照只是结果子集，会把已有词
    // 误判为新词，addWord 命中后端幂等后丢弃本次富化数据。改为按词窄查
    // 词库后做精确比对（大小写不敏感，对齐 SQLite lower() 的 ASCII 语义）——
    // search 走的是模糊 LIKE，不能拿"搜索有结果"当"已存在"。
    // 查询带上限但取较宽的候选集（与另一条加词路径的预检上限一致）：
    // 精确词可能排在大量 LIKE 命中之后，上限过小会漏判、重新落回"已存在
    // 却报已添加/丢弃本次数据"的旧路径。
    let existing: Word[] | null = null;
    try {
      existing = await getWords(500, 0, wordText);
    } catch (err) {
      // 预检失败按未命中处理，退回完整流程（后端 add_word 幂等兜底）
      console.warn("Vocabulary existence precheck failed:", err);
    }
    if (existing?.some((w) => asciiLower(w.word) === asciiLower(wordText))) {
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
