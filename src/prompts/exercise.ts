import { CATEGORY_EXERCISE_TYPE, EXERCISE_TYPE_LABEL } from "@/lib/type-config";

/**
 * 构建练习题生成的 prompt。
 * 根据错误类别和对应题型，要求 LLM 生成 5 道针对性练习题。
 */
export function buildExercisePrompt(category: string, userContext?: string): string {
  const exerciseType = CATEGORY_EXERCISE_TYPE[category] ?? "rewrite";
  const typeLabel = EXERCISE_TYPE_LABEL[exerciseType];

  const basePrompt = `你是一个专业的英语语法教练。用户在"${category}"方面存在薄弱项，请生成 5 道针对性练习题帮助其巩固。

题型：${typeLabel}

请严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹：

{
  "exercises": [
    {
      "type": "${exerciseType}",
      "question": "题目描述（包含完整的句子或语境）",
      ${exerciseType === "fill" ? '"options": ["选项A", "选项B", "选项C", "选项D"],' : ""}
      "answer": "正确答案",
      "explanation": "中文解析，说明为什么这个答案正确"
    }
  ]
}

要求：
- 5 道题难度递进，从简单到中等
- 题目内容贴近实际英语使用场景
- explanation 用中文简洁明了地解释语法点
- ${exerciseType === "fill" ? "每题 4 个选项，只有 1 个正确" : ""}
- ${exerciseType === "correct" ? "每题包含 1 个错误，用户需要找出并改正" : ""}
- ${exerciseType === "rewrite" ? "给出有问题的句子，用户需要用正确方式重写" : ""}
- 只输出 JSON，不要其他内容`;

  return userContext ? `${basePrompt}\n\n${userContext}` : basePrompt;
}
