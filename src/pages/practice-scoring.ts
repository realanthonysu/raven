/**
 * @module practice-scoring
 * @description 练习页的打分口径纯函数。
 *
 * 打分口径原先内联在各页面的提交循环/视图层里，这里收敛为可单测的纯函数，
 * 作为口径的唯一事实来源（页面提交与测试共用同一入口）。
 */

import { matchAnswerDetail } from "@/lib/parse-utils";

/**
 * 听写打分：逐句用 matchAnswerDetail 的三态比对计分。
 *
 * 口径：correct 计 1 分、close（词级差异 ≤ 1 的"接近"）计 0.5 分、wrong 计 0 分。
 * "close 计 0.5" 的口径原先内联在 ListeningPage 的提交循环里，收敛到本函数后
 * review 视图的逐句着色仍直接用 matchAnswerDetail 三态，总分与逐句判定天然同源。
 *
 * @param inputs - 用户逐句的听写输入（与 sentences 等长、下标一一对应）
 * @param sentences - LLM 生成的原句列表（只消费 text 字段）
 * @returns 总得分（可能带 0.5 的小数）
 */
export function scoreDictation(inputs: string[], sentences: { text: string }[]): number {
  return inputs.reduce((sum, input, i) => {
    const result = matchAnswerDetail(input, sentences[i].text, "rewrite");
    if (result === "correct") return sum + 1;
    if (result === "close") return sum + 0.5;
    return sum;
  }, 0);
}
