/**
 * useAddToVocabulary —— 共享的"添加到生词本"hook。
 *
 * 将 CorrectPage、ReadingPage、ListeningPage 中重复的
 * "enrichWord → addWord → 更新 addedWords"逻辑抽取为共享 hook。
 *
 * 用法：
 *   const { addedWords, enriching, addToVocabulary } = useAddToVocabulary();
 *   await addToVocabulary("hello", "context text", "reading");
 */
import { useCallback, useRef, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { addWord } from "@/lib/db";
import { buildEnrichmentNotes } from "@/lib/word-utils";
import { enrichWord } from "@/services/llm";

export function useAddToVocabulary() {
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());
  const addedWordsRef = useRef<Set<string>>(new Set());
  const [enriching, setEnriching] = useState(false);
  const [addingWord, setAddingWord] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();

  /**
   * 将单词添加到生词本。
   *
   * @param word - 要添加的英文单词
   * @param sourceText - 来源上下文（可选，最多 200 字符）
   * @param sourceType - 来源类型（"correct" | "reading" | "listening"）
   * @returns true 表示添加成功，false 表示已存在或失败
   */
  const addToVocabulary = useCallback(
    async (
      word: string,
      sourceText?: string,
      sourceType: string = "manual",
      fallbackDefinition?: string,
    ): Promise<boolean> => {
      if (addedWordsRef.current.has(word)) return false;

      setEnriching(true);
      setAddingWord(word);

      let phonetic: string | null = null;
      let definition = fallbackDefinition ?? "待补充";
      let collocations = "";
      let example = "";

      // 中止旧请求并获取新 signal（useAbortable 内部管理生命周期）
      abort();
      const signal = getSignal();

      try {
        const enriched = await enrichWord(word, signal);
        if (signal.aborted) return false;
        if (enriched) {
          phonetic = enriched.phonetic;
          definition = enriched.definition;
          collocations = enriched.collocations;
          example = enriched.example;
        }
      } catch {
        // enrichment failed — proceed with fallback data
      }

      try {
        await addWord({
          word,
          phonetic,
          definition,
          level: null,
          source_type: sourceType,
          source_text: sourceText?.slice(0, 200) ?? null,
          notes: buildEnrichmentNotes({ phonetic, definition, collocations, example }),
          review_status: "new",
        });
        addedWordsRef.current = new Set(addedWordsRef.current).add(word);
        setAddedWords(addedWordsRef.current);
        return true;
      } catch (e) {
        console.warn("Failed to add word:", e);
        return false;
      } finally {
        setEnriching(false);
        setAddingWord(null);
      }
    },
    [abort, getSignal],
  );

  return { addedWords, enriching, addingWord, addToVocabulary };
}
