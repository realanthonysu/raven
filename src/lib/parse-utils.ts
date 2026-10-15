/**
 * JSON 解析工具 —— 专门处理 LLM 返回的不稳定 JSON 格式。
 *
 * LLM（尤其是非 GPT-4 级别模型）返回 JSON 时常有格式问题：
 * 1. 整个响应就是一个合法 JSON（理想情况）
 * 2. JSON 被包裹在 markdown 代码块中（```json ... ```）
 * 3. JSON 前后混有解释性文字（"以下是结果：" + JSON + "希望对你有帮助"）
 *
 * 三级回退策略依次尝试，任一成功即返回，全部失败返回 null。
 * 调用方（CorrectPage）对 null 结果会展示原始文本作为兜底。
 */

import type { ZodType } from "zod";
import { CorrectionResultSchema } from "@/lib/schemas";
import type { CorrectionResult, ExerciseType } from "@/types";

/**
 * 从 LLM 输出中提取并解析 JSON，支持三级回退策略。
 *
 * 依次尝试：直接 JSON.parse → 提取 markdown 代码块 → 花括号/方括号匹配。
 * 每一级解析后可选地通过 `validate` 函数进行运行时类型校验。
 *
 * @param text - LLM 返回的原始文本
 * @param validate - 可选的运行时校验函数（如 Zod schema 的 safeParse），校验失败则跳过该级结果
 * @returns 解析成功返回目标类型，全部失败返回 null
 */
export function extractJson<T>(text: string, validate: (data: unknown) => data is T): T | null;
export function extractJson<T>(text: string, validate?: (data: unknown) => boolean): T | null;
export function extractJson<T>(text: string, validate?: (data: unknown) => boolean): T | null {
  if (!text?.trim()) return null;

  // Level 1: Direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (!validate || validate(parsed))
      // WARNING: No runtime validation — the cast is unchecked.
      // Prefer providing a `validate` function for critical paths.
      return parsed as T;
  } catch {
    /* continue */
  }

  // Level 2: Extract from markdown code blocks。
  // 逐个尝试所有代码块——LLM 可能在解释文字中先输出空/伪代码块，
  // 只试第一个会错过真正的 JSON 块
  const codeBlockPattern = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  for (const match of text.matchAll(codeBlockPattern)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (!validate || validate(parsed)) return parsed as T;
    } catch {
      /* 该代码块不是合法 JSON，继续尝试下一个 */
    }
  }

  // Level 3: Extract outermost JSON (brace matching, string-aware)。
  // 首个候选括号对解析/校验失败后继续扫描下一对——
  // 文本形如 “见 [附录] 下方 {json}” 时第一个括号对不是 JSON
  let searchFrom = 0;
  // 某类括号一旦出现“扫描到文本尾都没找到配对闭合”（截断 JSON 的典型形态），
  // 就把该次扫描的逐位置深度记录下来（unclosedSkip）：之后同类型起点可 O(1)
  // 判定是否同样注定不闭合并直接跳过。没有这套记录时，大量未配对括号会让每个
  // 起点都重新扫到文本尾，复杂度退化成 O(n²)。两类括号各自独立记录——
  // “{” 截断不影响后续 “[” 的配对。跳过判定与“真的扫一遍并失败”完全等价，
  // 依据见 buildUnclosedTable 的注释推导
  const unclosedSkip: Record<"{" | "[", Uint8Array | null> = { "{": null, "[": null };
  while (searchFrom < text.length) {
    const firstBrace = text.indexOf("{", searchFrom);
    const firstBracket = text.indexOf("[", searchFrom);
    if (firstBrace === -1 && firstBracket === -1) return null;
    let start: number;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);

    // start 只可能是 firstBrace（"{"）或 firstBracket（"["）之一
    const openChar = text[start] as "{" | "[";
    const closeChar = openChar === "{" ? "}" : "]";
    // 已确认该起点扫描到尾部也不配对：与真实扫描失败的行为一致（searchFrom 前进一位）
    if (unclosedSkip[openChar]?.[start]) {
      searchFrom = start + 1;
      continue;
    }
    const closePos = scanBracketPair(text, start, openChar, closeChar);
    if (closePos !== null) {
      try {
        const parsed = JSON.parse(text.slice(start, closePos + 1));
        if (!validate || validate(parsed)) return parsed as T;
      } catch {
        /* 该候选区段不是合法 JSON，继续扫描下一对括号 */
      }
      searchFrom = closePos + 1;
      continue;
    }
    // 扫描到文本尾仍未配对：记录深度现场，供后续同类型起点 O(1) 跳过
    if (!unclosedSkip[openChar]) {
      const depthLog = new Int32Array(text.length);
      // 重扫一次只为把逐位置深度写进 depthLog（状态机确定，必然同样返回 null）
      scanBracketPair(text, start, openChar, closeChar, depthLog);
      unclosedSkip[openChar] = buildUnclosedTable(depthLog, start);
    }
    searchFrom = start + 1;
  }
  return null;
}

/**
 * 从 start 处的开括号出发，做字符串感知的括号配对扫描。
 *
 * 与 extractJson Level 3 的主扫描是同一套状态机（转义 → 引号 → 深度），
 * 修改其中之一必须同步另一个：两者对“配对闭合位置”的判定必须一致。
 *
 * @param depthLog - 可选。传入时把“处理完每个位置后的净深度”写入 depthLog[i]
 *   （下标即文本位置），供扫描失败时推断后续起点的命运；不影响返回值
 * @returns 首个让深度归 0 的闭合括号位置；扫描到文本尾仍未配对返回 null
 */
function scanBracketPair(
  text: string,
  start: number,
  openChar: string,
  closeChar: string,
  depthLog?: Int32Array,
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\" && inString) {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
    if (depthLog) depthLog[i] = depth;
  }
  return null;
}

/**
 * 由一次“扫描到文本尾仍未配对”的深度日志，推出后续同类型起点中哪些同样注定不闭合。
 *
 * 判定依据（与“真的从该起点扫一遍”结论一致，故跳过不改变提取行为）：
 * 设那次扫描的起点为 p，depthLog[i] 是它处理到位置 i 时的净深度（未配对开括号数；
 * 扫描失败意味着它全程 ≥ 1，且引号/转义状态由 p 的扫描决定）。对之后的起点 q：
 * - 若 q 是 p 的扫描眼中的“活”开括号（深度恰在 q 处 +1，等价于 q 不在 p 扫描的
 *   字符串内），则两次扫描经过 q 之后的引号状态一致，从 q 出发的深度恒等于
 *   1 + depthLog[j] - depthLog[q]；
 * - 于是从 q 出发能找到配对闭合 ⟺ depthLog 在 q 之后回落到 depthLog[q] - 1。
 *   只要 q 之后深度再也回不到 depthLog[q] - 1（后缀最小值 ≥ depthLog[q]），
 *   从 q 出发就必然同样扫描到尾部也不闭合——此时跳过与该起点真实扫描失败等价。
 *
 * @param depthLog - scanBracketPair 失败时写入的逐位置深度（下标即文本位置）
 * @param openIdx - 那次失败扫描的起点 p（只覆盖 p 之后的位置）
 * @returns 表：table[i] === 1 表示从位置 i 的同类型开括号出发注定扫描到尾部也不配对
 */
function buildUnclosedTable(depthLog: Int32Array, openIdx: number): Uint8Array {
  const table = new Uint8Array(depthLog.length);
  let suffixMin = Number.POSITIVE_INFINITY; // depthLog 在 (i, 末尾] 上的最小值
  for (let i = depthLog.length - 1; i > openIdx; i--) {
    const depth = depthLog[i];
    // 深度恰在 i 处 +1 ⇒ i 是那次扫描的活开括号；后缀最小值不小于当前深度
    // ⇒ 之后再回不到 depth-1，从 i 出发注定不闭合
    if (depth - depthLog[i - 1] === 1 && suffixMin >= depth) table[i] = 1;
    if (depth < suffixMin) suffixMin = depth;
  }
  return table;
}

/**
 * extractJson 的安全重载：接受 Zod schema 进行运行时校验。
 *
 * 相比手写 type guard，调用方只需传入 schema 即可获得类型安全的解析结果。
 * 解析或校验失败时返回 null，不抛出异常。
 *
 * 校验通过时返回 `safeParse` 的输出（而非原始 JSON.parse 结果），
 * 避免「再 parse 一次 + 丢弃 Zod 产物」的双重开销，也正确承接
 * schema 上的 transform/default。
 *
 * @param text - LLM 返回的原始文本
 * @param schema - Zod schema，用于校验解析结果
 * @returns 校验通过返回解析结果，失败返回 null
 */
export function extractJsonSafe<T>(text: string, schema: ZodType<T>): T | null {
  // 闭包捕获 safeParse 的 data：extractJson 的三级回退只复用其扫描逻辑，
  // 返回值不再使用（原先会把未消毒的 JSON.parse 结果 cast 回来）
  let result: T | null = null;
  extractJson(text, (d) => {
    const parsed = schema.safeParse(d);
    if (parsed.success) {
      result = parsed.data;
      return true;
    }
    return false;
  });
  return result;
}

/**
 * 从 LLM 响应文本中解析 CorrectionResult JSON。
 *
 * 委托给统一的 extractJsonSafe + CorrectionResultSchema（唯一的解析校验入口）。
 * 保留此函数仅为 API 兼容：CorrectPage / HistoryDetailPage 仍在使用；
 * 新代码请直接调用 extractJsonSafe(text, CorrectionResultSchema)。
 *
 * @param text - LLM 返回的原始文本
 * @returns 解析成功返回 CorrectionResult，失败返回 null
 */
export function parseCorrectionJson(text: string): CorrectionResult | null {
  return extractJsonSafe(text, CorrectionResultSchema);
}

/**
 * 将英文文本按句子分割。
 *
 * 使用句末标点（.!?）后跟空白作为分隔点，保留标点在句尾。
 * 不做缩写词（Mr. Dr.）的特殊处理——对英语学习场景够用。
 *
 * @param text - 待分割的英文文本
 * @returns 非空句子数组
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 去除英文标点和连字符，用于答案比对时忽略标点差异。 */
const stripPunct = (s: string) => s.replace(/[.,!?;:'"()[\]{}—–-]/g, "");

/** 归一化答案：小写、去标点、合并空白。用于 correct/rewrite 题型比对。 */
const normalize = (s: string) => stripPunct(s).replace(/\s+/g, " ").trim();

/**
 * 按题型比对用户答案与正确答案。
 *
 * - fill（填空题）：精确匹配（trim + toLowerCase），单个词/短语容不得偏差
 * - correct/rewrite（改错/重写题）：归一化空白 + 去除标点后匹配，
 *   听写场景下大小写和标点差异不应判定为错误
 *
 * @param userAnswer - 用户提交的答案
 * @param correctAnswer - 标准正确答案
 * @param type - 题型（fill / correct / rewrite）
 * @returns 答案是否匹配
 */
export function matchAnswer(
  userAnswer: string,
  correctAnswer: string,
  type: ExerciseType,
): boolean {
  const ua = userAnswer.trim().toLowerCase();
  const ca = correctAnswer.trim().toLowerCase();
  if (type === "fill") return ua === ca;
  return normalize(ua) === normalize(ca);
}

/**
 * 三态答案比对：correct（完全匹配）/ close（接近）/ wrong（错误）。
 *
 * - fill：精确匹配
 * - correct/rewrite：归一化后完全匹配为 correct；
 *   词级差异 ≤ 1 个词为 close；否则为 wrong
 *
 * "接近"判定基于词级差异而非字符编辑距离，避免 "She goes" vs "He goes"
 * 这种不同单词被误判为接近。
 *
 * @param userAnswer - 用户提交的答案
 * @param correctAnswer - 标准正确答案
 * @param type - 题型（fill / correct / rewrite）
 * @returns 三态匹配结果："correct" | "close" | "wrong"
 */
export function matchAnswerDetail(
  userAnswer: string,
  correctAnswer: string,
  type: ExerciseType,
): "correct" | "close" | "wrong" {
  const ua = userAnswer.trim().toLowerCase();
  const ca = correctAnswer.trim().toLowerCase();
  if (type === "fill") return ua === ca ? "correct" : "wrong";
  const nu = normalize(ua);
  const nc = normalize(ca);
  if (nu === nc) return "correct";
  // 词级差异判定：分词后比较，差异词数 ≤ 1 → close
  const wordsU = nu.split(" ");
  const wordsC = nc.split(" ");
  const diff = Math.abs(wordsU.length - wordsC.length);
  const minLen = Math.min(wordsU.length, wordsC.length);
  let mismatches = 0;
  for (let i = 0; i < minLen; i++) {
    if (wordsU[i] !== wordsC[i]) mismatches++;
  }
  // 总差异 = 词数差 + 词内容不同数
  if (diff + mismatches <= 1) return "close";
  return "wrong";
}

/**
 * 将 LLM 返回的 Markdown 按 ## 标题分割为键值对。
 *
 * Reading Copilot 的 LLM 被要求按 6 个维度（参考翻译、重点词汇等）输出，
 * 每个维度以 `## ` 开头。此函数将 Markdown 文本拆分为 Record<title, content>，
 * 供 ReadingPage 用 readingSectionConfig 渲染为独立的 ResultCard。
 *
 * 使用正向前瞻 `(?=^##[ \t])` 分割，保留分隔符在每段开头。
 * 只提取同时有标题和内容的段落，忽略空段落。
 *
 * 注意：此函数也用于 HistoryDetailPage 回放历史记录。
 *
 * @param text - LLM 返回的 Markdown 文本，按 `## 标题` 分节
 * @returns 标题 → 内容的键值对，仅包含同时有标题和内容的段落
 */
export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Split by lines that start with ##
  const parts = text.split(/(?=^##[ \t])/gm);
  for (const part of parts) {
    const headerMatch = part.match(/^##[ \t]*(.+)\n?/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      const content = part.slice(headerMatch[0].length).trim();
      if (title && content) {
        sections[title] = content;
      }
    }
  }
  return sections;
}
