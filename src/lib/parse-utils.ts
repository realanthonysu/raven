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
 * 从 LLM 响应文本中解析 CorrectionResult JSON。
 *
 * @param text - LLM 返回的原始文本
 * @returns 解析成功返回 CorrectionResult，失败返回 null
 */
export function parseCorrectionJson(text: string): CorrectionResult | null {
  // 第一级：直接解析（理想情况，LLM 返回纯 JSON）
  try {
    return JSON.parse(text);
  } catch {
    // 第二级：从 markdown 代码块中提取（LLM 常用 ```json 包裹输出）
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    // 第三级：用贪婪匹配找到最外层 { ... } 块（处理前后有解释文字的情况）
    // 注意：\{[\s\S]*\} 是贪婪匹配，如果文本中有多个 JSON 对象会匹配到最大的那个
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
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
