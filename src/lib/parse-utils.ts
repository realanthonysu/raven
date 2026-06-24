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
import type { CorrectionResult, ExerciseType } from "@/types";

/**
 * Extract and parse JSON from LLM output with multi-level fallback.
 * Tries: direct parse → code block extraction → brace matching.
 */
export function extractJson<T>(text: string, validate?: (data: unknown) => data is T): T | null {
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
 * 从 LLM 响应文本中解析 CorrectionResult JSON。
 *
 * 委托给通用的 `extractJson` 实现，保留此函数仅为 API 兼容。
 * 旧版使用贪婪正则 `\{[\s\S]*\}` 匹配最外层大括号，
 * 新版使用逐字符深度匹配，对多个 JSON 对象的场景更健壮。
 *
 * @param text - LLM 返回的原始文本
 * @returns 解析成功返回 CorrectionResult，失败返回 null
 */
export function parseCorrectionJson(text: string): CorrectionResult | null {
  return extractJson<CorrectionResult>(text);
}

/**
 * 将英文文本按句子分割。
 *
 * 使用句末标点（.!?）后跟空白作为分隔点，保留标点在句尾。
 * 不做缩写词（Mr. Dr.）的特殊处理——对英语学习场景够用。
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 按题型比对用户答案与正确答案。
 *
 * - fill（填空题）：精确匹配（trim + toLowerCase），单个词/短语容不得偏差
 * - correct/rewrite（改错/重写题）：归一化空白 + 去除标点后匹配，
 *   听写场景下大小写和标点差异不应判定为错误
 */
export function matchAnswer(
  userAnswer: string,
  correctAnswer: string,
  type: ExerciseType,
): boolean {
  const ua = userAnswer.trim().toLowerCase();
  const ca = correctAnswer.trim().toLowerCase();
  if (type === "fill") return ua === ca;
  const stripPunct = (s: string) => s.replace(/[.,!?;:'"()[\]{}—–-]/g, "");
  const normalize = (s: string) => stripPunct(s).replace(/\s+/g, " ").trim();
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
 */
export function matchAnswerDetail(
  userAnswer: string,
  correctAnswer: string,
  type: ExerciseType,
): "correct" | "close" | "wrong" {
  const ua = userAnswer.trim().toLowerCase();
  const ca = correctAnswer.trim().toLowerCase();
  if (type === "fill") return ua === ca ? "correct" : "wrong";
  const stripPunct = (s: string) => s.replace(/[.,!?;:'"()[\]{}—–-]/g, "");
  const normalize = (s: string) => stripPunct(s).replace(/\s+/g, " ").trim();
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
