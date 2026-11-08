/**
 * useLanguageDetection —— 封装语言检测的 LLM 调用和状态管理。
 *
 * ReadingPage 在精读分析前调用此 hook 判断输入是否为英文，
 * 非英文则拦截并提示用户。
 *
 * 单飞管线（useAbortable + useStaleGuard + 模型解析 + 解析校验 + stale 自检）
 * 由 useLlmTask 原语承载——模型解析随之收编进 hook（detectLanguage 不再要求
 * 调用方先 resolveModel），本 hook 只负责 outcome → 返回值的映射。
 *
 * S-11：明显英文（ASCII 字母占比高）在本地直接判定，省掉一次 LLM 往返；
 * 短文本、混合语言与非英文仍交给 LLM（本地规则只做"确定是英文"的快速通道，
 * 不做"确定不是英文"的判定，避免误拦截）。
 */
import { useCallback, useState } from "react";
import { useLlmTask } from "@/hooks/use-llm-task";
import { LanguageDetectionSchema } from "@/lib/schemas";
import { DETECT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { LanguageDetection } from "@/types";

/** 检测服务不可用的 fail-closed 文案（仅 error 分支使用；not-configured 走原语外传的规范文案，见下）。 */
const DETECTION_UNAVAILABLE_REASON = "语言检测服务暂时不可用，请检查网络后重试";

/**
 * 本地快速判定所需的最少字母数（S-11）。
 *
 * 过短文本（单词/短语）的字母占比不可靠（一个中文词夹几个英文字母就可能越界），
 * 且 LLM 对短文本的判定成本本来就低，因此短文本一律走 LLM。
 */
const MIN_LETTERS_FOR_LOCAL_VERDICT = 20;

/** 本地快速判定所需的 ASCII 字母占比下限（S-11）。 */
const MIN_ASCII_LETTER_RATIO = 0.9;

/**
 * 常见英文功能词（S-11 第二层证据）。
 *
 * 只看字母构成会被"无变音符的罗曼语文本"骗过（如不含重音符号的西班牙语/意大利语
 * 段落同样是纯 ASCII 字母），故要求文本出现至少 {@link MIN_FUNCTION_WORDS} 个
 * 互不相同的常见功能词。这层证据极便宜（按非字母切分 + Set 命中，命中即早退），
 * 却把"看起来像英文"收紧为"用英文虚词写的文本"。
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "is",
  "are",
  "was",
  "were",
  "it",
  "this",
  "that",
  "these",
  "those",
  "for",
  "with",
  "as",
  "on",
  "at",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "not",
  "but",
  "from",
  "by",
  "they",
  "them",
  "their",
  "there",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "his",
  "her",
  "which",
  "who",
  "when",
  "where",
  "what",
  "how",
  "all",
  "more",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "also",
  "than",
  "then",
  "so",
  "if",
  "into",
  "about",
  "after",
  "before",
  "because",
  "while",
  "each",
  "other",
  "such",
  "only",
  "same",
  "most",
  "some",
  "any",
  "no",
  "nor",
  "too",
  "very",
  "a",
  "an",
  "do",
  "does",
  "did",
  "up",
  "out",
  "over",
  "under",
  "between",
  "during",
  "without",
  "through",
  "against",
  "us",
  "me",
  "my",
  "its",
]);

/** 本地快速判定所需的互异功能词数量（S-11）。 */
const MIN_FUNCTION_WORDS = 3;

/** 非 ASCII 字母的 Unicode 属性判定（CJK、全角、带音标拉丁字母等）。 */
const NON_ASCII_LETTER_RE = /\p{L}/u;

/**
 * 本地"明显英文"判定（S-11，纯函数，导出供单测）。
 *
 * 两层证据，全部满足才快速通过：
 * 1. 字母构成：全文（Unicode）字母数 ≥ {@link MIN_LETTERS_FOR_LOCAL_VERDICT}，
 *    且其中 ASCII 拉丁字母占比 ≥ {@link MIN_ASCII_LETTER_RATIO}
 *    （数字、标点、空白不参与分母，避免代码块/公式较多的文本被误判）；
 * 2. 词形证据：至少出现 {@link MIN_FUNCTION_WORDS} 个互异的常见英文功能词。
 *
 * 只会返回"是英文"的确定结论：任一层证据不足即返回 false，由调用方回落到 LLM
 * （本地不做"非英文"判定，避免误拦截边缘文本——宁可多一次 LLM 往返）。
 */
export function isObviouslyEnglish(text: string): boolean {
  let asciiLetters = 0;
  let letters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      asciiLetters += 1;
      letters += 1;
      continue;
    }
    // ASCII 非字母（数字/标点/空白/换行）不计入分母
    if (code < 0x80) continue;
    const codePoint = text.codePointAt(i) ?? code;
    if (codePoint > 0xffff) i += 1; // 代理对占两个 code unit
    if (NON_ASCII_LETTER_RE.test(String.fromCodePoint(codePoint))) {
      letters += 1;
    }
  }
  if (letters < MIN_LETTERS_FOR_LOCAL_VERDICT) return false;
  if (asciiLetters / letters < MIN_ASCII_LETTER_RATIO) return false;

  // 第二层：功能词证据。按非字母/撇号切分，命中去重后达到下限即通过
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z']+/)) {
    if (!ENGLISH_FUNCTION_WORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= MIN_FUNCTION_WORDS) return true;
  }
  return false;
}

/** 本地快速判定的结果文案（与 LLM 通道的 reason 同形状；仅在失败时才会展示）。 */
const LOCAL_ENGLISH_REASON = "明显英文文本（本地快速判定）";

export function useLanguageDetection() {
  const [detecting, setDetecting] = useState(false);
  const { run: runTask, cancel: cancelTask } = useLlmTask<LanguageDetection>();

  /**
   * 检测输入文本是否为英文。
   * @returns LanguageDetection 对象（isEnglish 字段表示是否英文），
   *          null = 检测被中止（用户重置/重新提交）或被更新的检测取代（superseded），
   *          调用方应直接放弃本次流程
   */
  const detectLanguage = useCallback(
    async (text: string): Promise<LanguageDetection | null> => {
      // S-11：明显英文在本地直接给出结论，不发 LLM 请求
      if (isObviouslyEnglish(text)) {
        // 与 runTask 的单飞语义对齐：本地判定立即接管，在途的旧请求作废
        //（旧调用随后返回 aborted → null，不会把 detecting 改回去）
        cancelTask();
        setDetecting(false);
        return { isEnglish: true, reason: LOCAL_ENGLISH_REASON };
      }

      setDetecting(true);

      const outcome = await runTask({
        // R4: 共享的 streamChatAsync，单步流式调用
        buildText: ({ model, signal }) =>
          streamChatAsync(buildPrompt(DETECT_PROMPT, text), model, signal),
        // O1: 集中管理的 Zod schema 校验由原语的 extractJsonSafe 承载
        schema: LanguageDetectionSchema,
      });

      // 被取代的旧调用不得清零新调用的 detecting：detecting 归新调用所有，
      // 且本流程已被接管——与中止同语义，返回 null 让调用方放弃
      if (outcome.status === "superseded") return null;
      setDetecting(false);

      switch (outcome.status) {
        case "parsed":
          return outcome.data;
        case "parse-failed":
          // M2: 解析失败时 fail closed，阻止非英文文本进入分析
          return { isEnglish: false, reason: "语言检测结果解析失败，请重试" };
        case "error":
          // M2: 检测失败时 fail closed（中止不算失败，已在上方归为 null 通道）
          return { isEnglish: false, reason: DETECTION_UNAVAILABLE_REASON };
        case "not-configured":
          // 模型解析收编进原语后，未配置模型在检测内部报 not-configured。
          // 映射为通道规范文案（原语默认即 MODEL_NOT_CONFIGURED_MESSAGE），
          // 与改造前 ReadingPage 前置 resolveModel 返回 null 时的横幅逐字一致
          return { isEnglish: false, reason: outcome.message };
        case "aborted":
          // 中止不是失败：返回 null 让调用方放弃本次流程（此前返回 isEnglish:true
          // 会放行并让 handleAnalyze 继续提交旧文本分析，重置操作失效）
          return null;
      }
    },
    [runTask, cancelTask],
  );

  /** 取消正在进行的语言检测请求并重置 detecting 状态。 */
  const cancelDetection = useCallback(() => {
    cancelTask();
    setDetecting(false);
  }, [cancelTask]);

  return { detecting, detectLanguage, cancelDetection };
}
