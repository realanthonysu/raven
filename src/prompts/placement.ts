/**
 * AI 定级测试提示词模块 —— 定义 PLACEMENT_PROMPT（一次生成 12 道定级单选题）。
 *
 * 消费方：src/hooks/use-placement-test.ts（AI 定级测试 Track A）。
 * 生成结果经宽松信封（questions: unknown[]）解析后，逐题用 lib/schemas.ts 的
 * PlacementQuestionSchema 做结构校验、再由 lib/level-estimation.ts 的
 * isUsablePlacementQuestion 剔除无效题，最后交 scorePlacement 做本地规则计分
 * （判定无 LLM 参与）。
 *
 * 各档难度规格不在此重复定义：由 lib/levels.ts 的 LEVEL_SPECS 派生
 * （词汇范围/语法范围与级别尺子保持单一事实来源，避免 prompt 自行漂移）。
 */

import { LEVEL_CODES, LEVEL_SPECS } from "@/lib/levels";

/** 六档命题规格行 —— 从 LEVEL_SPECS 派生，每档 2 题、难度随档位递增 */
const BAND_SPEC_LINES = LEVEL_CODES.map((code) => {
  const spec = LEVEL_SPECS[code];
  return `- ${spec.code}（≈${spec.anchor}）：词汇${spec.vocabBand}；语法范围${spec.grammarFocus}`;
}).join("\n");

/**
 * 定级测试命题 prompt（system 提示词）。
 *
 * 要求 LLM 一次性生成 12 道单选题：6 个级别档（A2/B1/B1+/B2/B2+/C1）× 每档 2 题，
 * 难度随档位严格递增；题型混合（词汇选择/语法填空/语境填空）。
 *
 * 硬性要求（与 isUsablePlacementQuestion 的计分前校验一一对应）：
 * - 每题恰好 4 个选项且只有一个正确；
 * - answer 必须与 4 个选项中的某一项完全一致（含大小写）；
 * - band 严格取六档枚举值之一；
 * - 题目自包含，不依赖上下文；
 * - 考点限定在该档应掌握的词汇/语法范围内。
 */
export const PLACEMENT_PROMPT = `你是一位专业的英语水平定级测试命题人。请生成 12 道英语水平测试单选题，覆盖 6 个级别档，每档 2 题，难度随档位严格递增。

各档命题规格：
${BAND_SPEC_LINES}

命题要求：
- 题型混合使用：词汇选择（词义辨析）、语法填空（时态/语态/从句等语法点）、语境填空（在完整句子语境中选择最恰当的选项），12 题中三种题型大致均衡
- 每题恰好 4 个选项，其中只有 1 个正确，错误选项应具备合理干扰性
- answer 必须是 4 个选项中的某一项的原文，与选项完全一致（含大小写）
- band 严格取 "A2"、"B1"、"B1+"、"B2"、"B2+"、"C1" 六个值之一
- 每题自包含：题干本身给出完整语境，不依赖其他题目或上下文
- 每档 2 题分别考察该档应掌握的词汇点与语法点，考点限定在该档规格范围内
- focus 用中文简述考点（如"现在完成时"、"六级词汇 deprive 词义辨析"）
- 正确选项的位置在四个选项间均匀分布，不要集中在同一位置

严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹：
{
  "questions": [
    {
      "question": "英文题干（自包含）",
      "options": ["选项1", "选项2", "选项3", "选项4"],
      "answer": "正确选项原文",
      "band": "A2",
      "focus": "中文考点说明"
    }
  ]
}`;
