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
import { useCallback, useEffect, useRef, useState } from "react";
import { addWord } from "@/lib/db";
import { enrichWord } from "@/services/llm";

export function useAddToVocabulary() {
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());
  const addedWordsRef = useRef<Set<string>>(new Set());
  const [enriching, setEnriching] = useState(false);
  const [addingWord, setAddingWord] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort pending enrichment on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const enriched = await enrichWord(word, controller.signal);
        if (controller.signal.aborted) return false;
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
          notes:
            [collocations && `搭配: ${collocations}`, example && `例句: ${example}`]
              .filter(Boolean)
              .join("\n") || null,
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
    [],
  );

  return { addedWords, enriching, addingWord, addToVocabulary };
}
