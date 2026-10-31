/**
 * useAddToVocabulary —— 共享的"添加到生词本"hook。
 *
 * 将 CorrectPage、ReadingPage（经 VocabularySection 及正文点击）、SpeakingPage 中重复的
 * "存在性预检 → enrichWord → addWord → 更新 addedWords"逻辑抽取为共享 hook。
 *
 * 用法：
 *   const { addedWords, enriching, addToVocabulary } = useAddToVocabulary();
 *   await addToVocabulary("hello", "context text", "reading");
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { addWord, wordExists } from "@/lib/db";
import { buildEnrichmentNotes, buildNewWordInput, PENDING_DEFINITION } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";

/** 调用方已掌握的词条数据（如 ReadingPage 词汇表解析结果），提供时跳过 LLM 补全。 */
export interface KnownWordData {
  phonetic: string | null;
  definition: string;
  collocations: string;
  example: string;
  /** 调用方已掌握的词汇等级（可选）；写入前经 toWordLevel 归一化 */
  level?: string | null;
}

/**
 * 共享的"添加到生词本"hook。
 *
 * 将单词添加到生词本，自动通过 LLM 补充音标、释义、搭配、例句等信息。
 * 支持并发添加多个单词（每个单词独立的 AbortController），组件卸载时统一中止。
 *
 * @returns 返回对象包含：
 *   - `addedWords` — 已标记为添加的单词集合（Set，含词库预检命中的已有词），用于 UI 判断是否已添加
 *   - `enriching` — 是否正在通过 LLM 丰富单词信息
 *   - `addingWord` — 当前正在添加的单词（无操作时为 null，仅用于向后兼容）
 *   - `addingWords` — 当前正在添加的所有单词集合（支持并发场景）
 *   - `addToVocabulary` — 执行添加操作的异步函数
 */
export function useAddToVocabulary() {
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());
  const addedWordsRef = useRef<Set<string>>(new Set());
  const [enriching, setEnriching] = useState(false);
  /** 当前正在添加的单词集合（支持并发添加多个单词） */
  const [addingWords, setAddingWords] = useState<Set<string>>(new Set());
  // addingWords 的同步镜像：finally 中需要读取最新集合判断是否清零 enriching。
  // 不能在 setState updater 内调用另一个 setState（违反 updater 纯函数约定，
  // StrictMode 双调用 / concurrent 渲染重放会重复触发该副作用）
  const addingWordsRef = useRef<Set<string>>(new Set());
  // 跟踪所有进行中的 AbortController，组件卸载时统一中止
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
   * @param sourceType - 来源类型（"correct" | "reading" | "speaking"，未传时默认 "manual"）
   * @param fallbackDefinition - LLM 补全失败时的兜底释义
   * @param known - 调用方已掌握的词条数据（如阅读页词汇表解析结果），
   *   提供时跳过 enrichWord 调用（数据已在页面上，无需重复请求 LLM）
   * @returns true 表示添加成功，false 表示词库已存在、正在添加中或失败
   */
  const addToVocabulary = useCallback(
    async (
      word: string,
      sourceText?: string,
      sourceType: string = "manual",
      fallbackDefinition?: string,
      known?: KnownWordData,
    ): Promise<boolean> => {
      // 防重仅保留 in-flight 窗口（同一单词并发提交时拒绝，避免按钮抖动/重复请求）；
      // addedWords 只作"本次会话已标记添加"的 UI 乐观标记，不阻止重复提交。
      if (addingWordsRef.current.has(word)) return false;

      setEnriching(true);
      // 使用 Set 跟踪并发添加中的单词，避免单值覆盖。
      // 登记必须在下方预检的 await 之前同步完成，否则预检窗口内同一单词的
      // 并发提交会绕过 in-flight 防重，形成重复请求。
      addingWordsRef.current = new Set(addingWordsRef.current).add(word);
      setAddingWords(addingWordsRef.current);

      // H3: 每次调用创建独立的 AbortController，不中止其他进行中的请求
      const controller = new AbortController();
      activeControllersRef.current.add(controller);
      const signal = controller.signal;

      try {
        // —— 词库存在性预检（D-05）——
        // 先查库防白耗 LLM 富化：后端 add_word 幂等命中时只返回旧 id、丢弃本次
        // 传入的全部新数据（音标/释义/笔记），若不预检，对词库已有词重复添加会
        // 先花一次 enrichWord LLM 调用（计费）再被后端丢弃。
        // 预检走 db_word_exists：lower(word) 唯一索引等值查询，只回一个布尔值，
        // 不再拉最多 500 条完整 WordDto 回前端做精确比对（旧方案还要处理
        // LIKE 模糊匹配与候选上限漏判）。大小写不敏感语义由 SQL 保证。
        const exists = await wordExists(word).catch((e) => {
          // 预检失败按未命中处理，退回完整流程（后端幂等兜底）
          console.warn("Vocabulary existence precheck failed:", e);
          return false;
        });
        // 预检期间组件可能已卸载中止：不再发起 LLM/写库（finally 统一清理）
        if (signal.aborted) return false;
        if (exists) {
          addedWordsRef.current = new Set(addedWordsRef.current).add(word);
          setAddedWords(addedWordsRef.current);
          return false;
        }

        let phonetic: string | null = known?.phonetic || null;
        let definition = known?.definition || fallbackDefinition || PENDING_DEFINITION;
        let collocations = known?.collocations ?? "";
        let example = known?.example ?? "";
        // 词汇等级候选：known 优先（调用方已掌握），否则取 LLM 补全结果。
        // 两侧数据都来自不可信来源（页面解析 / LLM 输出），写入前统一过
        // toWordLevel 归一化，非法值回退 null，不把脏值带进 words.level
        let levelCandidate: string | null | undefined = known?.level;

        if (!known) {
          try {
            const enriched = await enrichWord(word, signal);
            if (signal.aborted) return false;
            if (enriched) {
              phonetic = enriched.phonetic;
              definition = enriched.definition;
              collocations = enriched.collocations;
              example = enriched.example;
              levelCandidate = enriched.level;
            }
          } catch {
            // enrichment failed — proceed with fallback data
          }
        }

        await addWord(
          buildNewWordInput({
            word,
            phonetic,
            definition,
            level: levelCandidate,
            source_type: sourceType,
            source_text: sourceText?.slice(0, 200) ?? null,
            notes: buildEnrichmentNotes({ phonetic, definition, collocations, example }),
          }),
        );
        addedWordsRef.current = new Set(addedWordsRef.current).add(word);
        setAddedWords(addedWordsRef.current);
        return true;
      } catch (e) {
        // 预检已被 .catch 兜底、enrich 异常在上方就地吞掉，落到这里的只有写库失败
        console.warn("Failed to add word:", e);
        return false;
      } finally {
        activeControllersRef.current.delete(controller);
        const next = new Set(addingWordsRef.current);
        next.delete(word);
        addingWordsRef.current = next;
        setAddingWords(next);
        // 全部完成后同步清除 enriching（在 updater 外读取镜像集合判断）
        if (next.size === 0) setEnriching(false);
      }
    },
    [],
  );

  /** 向后兼容：取 addingWords 中的第一个单词（无操作时为 null） */
  const addingWord = addingWords.size > 0 ? (addingWords.values().next().value ?? null) : null;

  return { addedWords, enriching, addingWord, addingWords, addToVocabulary };
}
