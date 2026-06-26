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
import { buildEnrichmentNotes } from "@/lib/word-utils";
import { enrichWord } from "@/services/llm";

/**
 * 共享的"添加到生词本"hook。
 *
 * 将单词添加到生词本，自动通过 LLM 补充音标、释义、搭配、例句等信息。
 * 支持并发添加多个单词（每个单词独立的 AbortController），组件卸载时统一中止。
 *
 * @returns 返回对象包含：
 *   - `addedWords` — 已添加的单词集合（Set），用于 UI 判断是否已添加
 *   - `enriching` — 是否正在通过 LLM 丰富单词信息
 *   - `addingWord` — 当前正在添加的单词（无操作时为 null）
 *   - `addToVocabulary` — 执行添加操作的异步函数
 */
export function useAddToVocabulary() {
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());
  const addedWordsRef = useRef<Set<string>>(new Set());
  const [enriching, setEnriching] = useState(false);
  const [addingWord, setAddingWord] = useState<string | null>(null);
  // H3: 跟踪所有进行中的 AbortController，组件卸载时统一中止
  const activeControllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    return () => {
      for (const controller of activeControllersRef.current) {
        controller.abort();
      }
      activeControllersRef.current.clear();
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

      // H3: 每次调用创建独立的 AbortController，不中止其他进行中的请求
      const controller = new AbortController();
      activeControllersRef.current.add(controller);
      const signal = controller.signal;

      let phonetic: string | null = null;
      let definition = fallbackDefinition ?? "待补充";
      let collocations = "";
      let example = "";

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
        activeControllersRef.current.delete(controller);
        setEnriching(false);
        setAddingWord(null);
      }
    },
    [],
  );

  return { addedWords, enriching, addingWord, addToVocabulary };
}
