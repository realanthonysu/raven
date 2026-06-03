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
export function extractJson<T>(
  text: string,
  validate?: (data: unknown) => data is T
): T | null {
  if (!text?.trim()) return null;

  // Level 1: Direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (!validate || validate(parsed)) return parsed as T;
  } catch { /* continue */ }

  // Level 2: Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (!validate || validate(parsed)) return parsed as T;
    } catch { /* continue */ }
  }

  // Level 3: Extract outermost JSON (brace matching, string-aware)
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (firstBrace === -1 && firstBracket === -1) return null;
  let start: number;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
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
        } catch { /* continue */ }
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
 * - correct/rewrite（改错/重写题）：归一化空白后匹配，避免多一个空格就算错
 */
export function matchAnswer(
  userAnswer: string,
  correctAnswer: string,
  type: ExerciseType
): boolean {
  const ua = userAnswer.trim().toLowerCase();
  const ca = correctAnswer.trim().toLowerCase();
  if (type === "fill") return ua === ca;
  // 句子级：折叠连续空白后比较，忽略多余的空格/换行
  const normalize = (s: string) => s.replace(/\s+/g, " ");
  return normalize(ua) === normalize(ca);
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
