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

  // Level 2: Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (!validate || validate(parsed)) return parsed as T;
    } catch {
      /* continue */
    }
  }

  // Level 3: Extract outermost JSON (brace matching, string-aware)
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  if (firstBrace === -1 && firstBracket === -1) return null;
  let start: number;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (!validate || validate(parsed)) return parsed as T;
        } catch {
          /* continue */
        }
        break;
      }
    }
  }
  return null;
}

/**
 * extractJson 的安全重载：接受 Zod schema 进行运行时校验。
 *
 * 相比手写 type guard，调用方只需传入 schema 即可获得类型安全的解析结果。
 * 解析或校验失败时返回 null，不抛出异常。
 *
 * @param text - LLM 返回的原始文本
 * @param schema - Zod schema，用于校验解析结果
 * @returns 校验通过返回解析结果，失败返回 null
 */
export function extractJsonSafe<T>(text: string, schema: ZodType<T>): T | null {
  return extractJson(text, (d) => schema.safeParse(d).success);
}

/**
 * 从 LLM 响应文本中解析 CorrectionResult JSON。
 *
 * 委托给通用的 `extractJson` 实现，使用 Zod schema 进行运行时校验，
 * 确保解析结果符合 CorrectionResult 结构。保留此函数仅为 API 兼容。
 *
 * @param text - LLM 返回的原始文本
 * @returns 解析成功返回 CorrectionResult，失败返回 null
 */
export function parseCorrectionJson(text: string): CorrectionResult | null {
  return extractJson<CorrectionResult>(text, (d) => CorrectionResultSchema.safeParse(d).success);
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
