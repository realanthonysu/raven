import { describe, expect, it } from "vitest";
import {
  ASRTextResponseSchema,
  CorrectionResultSchema,
  CorrectionSchema,
  EnrichedWordSchema,
  ExerciseQuestionSchema,
  ExerciseResultSchema,
  ExerciseTypeSchema,
  GraphDataSchema,
  LanguageDetectionSchema,
  ListeningResultSchema,
  ListeningSentenceSchema,
  ReviewStatusSchema,
  SpeakingResultItemSchema,
  SpeakingResultSchema,
  SpeakingScoreSchema,
  TTSAudioResponseSchema,
  WordAlignmentItemSchema,
  WordLevelSchema,
} from "@/lib/schemas";

/**
 * EnrichedWordSchema 测试套件。
 *
 * 覆盖 LLM 词汇丰富响应的校验：
 * - 合法输入通过
 * - 缺少必填字段失败
 * - 类型错误失败
 */
describe("EnrichedWordSchema", () => {
  const validWord = {
    phonetic: "/wɜːrd/",
    definition: "单词",
    collocations: "word of mouth, in other words",
    example: "What does this word mean?",
  };

  it("校验合法的词汇丰富数据", () => {
    const result = EnrichedWordSchema.safeParse(validWord);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validWord);
  });

  it("缺少 phonetic 字段时校验失败", () => {
    const { phonetic, ...missing } = validWord;
    const result = EnrichedWordSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 definition 字段时校验失败", () => {
    const { definition, ...missing } = validWord;
    const result = EnrichedWordSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 collocations 字段时校验失败", () => {
    const { collocations, ...missing } = validWord;
    const result = EnrichedWordSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 example 字段时校验失败", () => {
    const { example, ...missing } = validWord;
    const result = EnrichedWordSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("phonetic 为数字时校验失败", () => {
    const result = EnrichedWordSchema.safeParse({ ...validWord, phonetic: 123 });
    expect(result.success).toBe(false);
  });

  it("definition 为 null 时校验失败", () => {
    const result = EnrichedWordSchema.safeParse({ ...validWord, definition: null });
    expect(result.success).toBe(false);
  });

  it("传入空对象时校验失败", () => {
    const result = EnrichedWordSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("传入非对象类型时校验失败", () => {
    expect(EnrichedWordSchema.safeParse("string").success).toBe(false);
    expect(EnrichedWordSchema.safeParse(42).success).toBe(false);
    expect(EnrichedWordSchema.safeParse(null).success).toBe(false);
    expect(EnrichedWordSchema.safeParse(undefined).success).toBe(false);
  });
});

/**
 * TTSAudioResponseSchema 测试套件。
 *
 * 覆盖 TTS API 响应结构的校验：
 * - 合法的 audio data 响应
 * - 空 choices 数组
 * - 缺少嵌套字段
 */
describe("TTSAudioResponseSchema", () => {
  const validResponse = {
    choices: [
      {
        message: {
          audio: {
            data: "base64encodedaudio==",
          },
        },
      },
    ],
  };

  it("校验合法的 TTS 音频响应", () => {
    const result = TTSAudioResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResponse);
  });

  it("空 choices 数组仍然合法", () => {
    const result = TTSAudioResponseSchema.safeParse({ choices: [] });
    expect(result.success).toBe(true);
    expect(result.data?.choices).toHaveLength(0);
  });

  it("缺少 choices 字段时校验失败", () => {
    const result = TTSAudioResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("choices 内缺少 message 字段时校验失败", () => {
    const result = TTSAudioResponseSchema.safeParse({
      choices: [{ noMessage: true }],
    });
    expect(result.success).toBe(false);
  });

  it("message 内缺少 audio 字段时校验失败", () => {
    const result = TTSAudioResponseSchema.safeParse({
      choices: [{ message: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("audio.data 不是字符串时校验失败", () => {
    const result = TTSAudioResponseSchema.safeParse({
      choices: [{ message: { audio: { data: 123 } } }],
    });
    expect(result.success).toBe(false);
  });

  it("choices 为非数组时校验失败", () => {
    const result = TTSAudioResponseSchema.safeParse({ choices: "not-array" });
    expect(result.success).toBe(false);
  });
});

/**
 * ASRTextResponseSchema 测试套件。
 *
 * 覆盖 ASR API 文本响应的校验：
 * - 合法响应
 * - 空 choices
 * - 缺少嵌套字段
 */
describe("ASRTextResponseSchema", () => {
  const validResponse = {
    choices: [
      {
        message: {
          content: "Hello, how are you?",
        },
      },
    ],
  };

  it("校验合法的 ASR 文本响应", () => {
    const result = ASRTextResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResponse);
  });

  it("空 choices 数组仍然合法", () => {
    const result = ASRTextResponseSchema.safeParse({ choices: [] });
    expect(result.success).toBe(true);
  });

  it("缺少 choices 字段时校验失败", () => {
    const result = ASRTextResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("message.content 不是字符串时校验失败", () => {
    const result = ASRTextResponseSchema.safeParse({
      choices: [{ message: { content: 123 } }],
    });
    expect(result.success).toBe(false);
  });

  it("缺少 message 字段时校验失败", () => {
    const result = ASRTextResponseSchema.safeParse({
      choices: [{ noMessage: true }],
    });
    expect(result.success).toBe(false);
  });

  it("缺少 content 字段时校验失败", () => {
    const result = ASRTextResponseSchema.safeParse({
      choices: [{ message: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("content 为空字符串仍然合法", () => {
    const result = ASRTextResponseSchema.safeParse({
      choices: [{ message: { content: "" } }],
    });
    expect(result.success).toBe(true);
  });
});

/**
 * CorrectionResultSchema 测试套件。
 *
 * 覆盖写作纠错结果的校验：
 * - 完整合法数据
 * - 空 corrections 数组
 * - corrections 内各项结构
 * - 缺少顶层字段
 */
describe("CorrectionResultSchema", () => {
  const validResult = {
    corrected_text: "She goes to school.",
    corrections: [
      {
        original: "She go to school.",
        corrected: "She goes to school.",
        category: "主谓一致",
        explanation: "第三人称单数主语需要使用 goes",
      },
    ],
    summary: "发现一处语法错误。",
  };

  it("校验合法的纠错结果", () => {
    const result = CorrectionResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResult);
  });

  it("空 corrections 数组仍然合法", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrections: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.corrections).toHaveLength(0);
  });

  it("缺少 corrected_text 字段时校验失败", () => {
    const { corrected_text, ...missing } = validResult;
    const result = CorrectionResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 corrections 字段时校验失败", () => {
    const { corrections, ...missing } = validResult;
    const result = CorrectionResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 summary 字段时校验失败", () => {
    const { summary, ...missing } = validResult;
    const result = CorrectionResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("corrections 内缺少 category 字段时校验失败", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrections: [
        {
          original: "She go to school.",
          corrected: "She goes to school.",
          explanation: "主谓一致",
          // category 缺失
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("corrections 内缺少 explanation 字段时校验失败", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrections: [
        {
          original: "She go to school.",
          corrected: "She goes to school.",
          category: "主谓一致",
          // explanation 缺失
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("corrected_text 为数字时校验失败", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrected_text: 123,
    });
    expect(result.success).toBe(false);
  });

  it("corrections 为非数组时校验失败", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrections: "not-array",
    });
    expect(result.success).toBe(false);
  });

  it("corrections 包含多项时全部通过校验", () => {
    const result = CorrectionResultSchema.safeParse({
      ...validResult,
      corrections: [
        {
          original: "She go to school.",
          corrected: "She goes to school.",
          category: "主谓一致",
          explanation: "第三人称单数",
        },
        {
          original: "I goed home.",
          corrected: "I went home.",
          category: "时态错误",
          explanation: "go 的过去式是 went",
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.corrections).toHaveLength(2);
  });
});

/**
 * GraphDataSchema 测试套件。
 *
 * 覆盖知识图谱数据的校验：
 * - 合法 nodes + edges
 * - 空 nodes/edges 数组
 * - .nullish() 字段（labelEn）接受 null、undefined 和合法值
 * - 缺少必填字段
 */
describe("GraphDataSchema", () => {
  const validGraph = {
    nodes: [
      { id: "1", label: "语法", labelEn: "grammar", type: "concept" },
      { id: "2", label: "时态", labelEn: null, type: "word" },
      { id: "3", label: "动词", type: "word" }, // labelEn 省略
    ],
    edges: [
      { source: "1", target: "2", relation: "包含" },
      { source: "2", target: "3", relation: "相关" },
    ],
  };

  it("校验合法的知识图谱数据", () => {
    const result = GraphDataSchema.safeParse(validGraph);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validGraph);
  });

  it("labelEn 为 null 时通过校验（.nullish()）", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", labelEn: null, type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.nodes[0].labelEn).toBeNull();
  });

  it("labelEn 为 undefined 时通过校验（.nullish()）", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(true);
    // nullish 字段省略后在解析结果中应为 undefined
    expect(result.data?.nodes[0].labelEn).toBeUndefined();
  });

  it("labelEn 为合法字符串时通过校验", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", labelEn: "test-en", type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.nodes[0].labelEn).toBe("test-en");
  });

  it("labelEn 为非字符串非 null 值时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", labelEn: 123, type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it("空 nodes 和 edges 数组仍然合法", () => {
    const result = GraphDataSchema.safeParse({ nodes: [], edges: [] });
    expect(result.success).toBe(true);
    expect(result.data?.nodes).toHaveLength(0);
    expect(result.data?.edges).toHaveLength(0);
  });

  it("缺少 nodes 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({ edges: [] });
    expect(result.success).toBe(false);
  });

  it("缺少 edges 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({ nodes: [] });
    expect(result.success).toBe(false);
  });

  it("node 缺少 id 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ label: "test", type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it("node 缺少 label 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", type: "word" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it("node 缺少 type 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it("edge 缺少 source 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", type: "word" }],
      edges: [{ target: "1", relation: "related" }],
    });
    expect(result.success).toBe(false);
  });

  it("edge 缺少 target 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", type: "word" }],
      edges: [{ source: "1", relation: "related" }],
    });
    expect(result.success).toBe(false);
  });

  it("edge 缺少 relation 字段时校验失败", () => {
    const result = GraphDataSchema.safeParse({
      nodes: [{ id: "1", label: "test", type: "word" }],
      edges: [{ source: "1", target: "2" }],
    });
    expect(result.success).toBe(false);
  });
});

/**
 * LanguageDetectionSchema 测试套件。
 *
 * 覆盖语言检测结果的校验：
 * - 合法输入（isEnglish + reason）
 * - .nullish() 字段（reason）接受 null、undefined 和合法值
 * - isEnglish 必须为 boolean
 * - 缺少必填字段
 */
describe("LanguageDetectionSchema", () => {
  it("校验合法的语言检测结果（reason 为字符串）", () => {
    const input = { isEnglish: true, reason: "文本为英文" };
    const result = LanguageDetectionSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("reason 为 null 时通过校验（.nullish()）", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: false,
      reason: null,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reason).toBeNull();
  });

  it("reason 为 undefined 时通过校验（.nullish()）", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reason).toBeUndefined();
  });

  it("isEnglish 为 true 时通过校验", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: true,
      reason: "English text",
    });
    expect(result.success).toBe(true);
  });

  it("isEnglish 为 false 时通过校验", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: false,
      reason: "Chinese text",
    });
    expect(result.success).toBe(true);
  });

  it("isEnglish 为字符串时校验失败", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: "yes",
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  it("isEnglish 为数字时校验失败", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: 1,
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 isEnglish 字段时校验失败", () => {
    const result = LanguageDetectionSchema.safeParse({ reason: "test" });
    expect(result.success).toBe(false);
  });

  it("reason 为数字时校验失败", () => {
    const result = LanguageDetectionSchema.safeParse({
      isEnglish: true,
      reason: 123,
    });
    expect(result.success).toBe(false);
  });
});

/**
 * ExerciseQuestionSchema 测试套件。
 *
 * 覆盖练习题结构的校验：
 * - 三种题型（fill / correct / rewrite）的合法数据
 * - optional 的 options 字段
 * - 缺少必填字段
 * - 无效的 type 枚举值
 */
describe("ExerciseQuestionSchema", () => {
  const validFillQuestion = {
    type: "fill" as const,
    question: "She ___ to school every day.",
    options: ["go", "goes", "going", "went"],
    answer: "goes",
    explanation: "第三人称单数主语用 goes",
  };

  const validCorrectQuestion = {
    type: "correct" as const,
    question: "找出并改正以下句子中的错误：She go to school.",
    answer: "She goes to school.",
    explanation: "主谓一致错误",
  };

  const validRewriteQuestion = {
    type: "rewrite" as const,
    question: "用过去时态改写以下句子：I go to school.",
    answer: "I went to school.",
    explanation: "go 的过去式为 went",
  };

  it("校验合法的填空题（含 options）", () => {
    const result = ExerciseQuestionSchema.safeParse(validFillQuestion);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validFillQuestion);
  });

  it("校验合法的改错题（无 options）", () => {
    const result = ExerciseQuestionSchema.safeParse(validCorrectQuestion);
    expect(result.success).toBe(true);
    expect(result.data?.options).toBeUndefined();
  });

  it("校验合法的重写题（无 options）", () => {
    const result = ExerciseQuestionSchema.safeParse(validRewriteQuestion);
    expect(result.success).toBe(true);
    expect(result.data?.options).toBeUndefined();
  });

  it("options 字段省略时通过校验（optional）", () => {
    const { options, ...withoutOptions } = validFillQuestion;
    const result = ExerciseQuestionSchema.safeParse(withoutOptions);
    expect(result.success).toBe(true);
    expect(result.data?.options).toBeUndefined();
  });

  it("options 为空数组时通过校验", () => {
    const result = ExerciseQuestionSchema.safeParse({
      ...validFillQuestion,
      options: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.options).toHaveLength(0);
  });

  it("type 为无效枚举值时校验失败", () => {
    const result = ExerciseQuestionSchema.safeParse({
      ...validFillQuestion,
      type: "invalid-type",
    });
    expect(result.success).toBe(false);
  });

  it("type 为数字时校验失败", () => {
    const result = ExerciseQuestionSchema.safeParse({
      ...validFillQuestion,
      type: 0,
    });
    expect(result.success).toBe(false);
  });

  it("缺少 type 字段时校验失败", () => {
    const { type, ...missing } = validFillQuestion;
    const result = ExerciseQuestionSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 question 字段时校验失败", () => {
    const { question, ...missing } = validFillQuestion;
    const result = ExerciseQuestionSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 answer 字段时校验失败", () => {
    const { answer, ...missing } = validFillQuestion;
    const result = ExerciseQuestionSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 explanation 字段时校验失败", () => {
    const { explanation, ...missing } = validFillQuestion;
    const result = ExerciseQuestionSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("question 为数字时校验失败", () => {
    const result = ExerciseQuestionSchema.safeParse({
      ...validFillQuestion,
      question: 123,
    });
    expect(result.success).toBe(false);
  });

  it("options 包含非字符串元素时校验失败", () => {
    const result = ExerciseQuestionSchema.safeParse({
      ...validFillQuestion,
      options: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });
});

/**
 * ExerciseResultSchema 测试套件。
 *
 * 覆盖完整练习结果的校验：
 * - 合法数据
 * - 缺少字段
 * - score 类型错误
 */
describe("ExerciseResultSchema", () => {
  const validResult = {
    category: "时态错误",
    exercises: [
      {
        type: "fill" as const,
        question: "She ___ to school.",
        options: ["go", "goes"],
        answer: "goes",
        explanation: "第三人称单数",
      },
    ],
    userAnswers: ["goes"],
    score: 100,
  };

  it("校验合法的练习结果", () => {
    const result = ExerciseResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResult);
  });

  it("score 为 0 时通过校验", () => {
    const result = ExerciseResultSchema.safeParse({ ...validResult, score: 0 });
    expect(result.success).toBe(true);
  });

  it("score 为小数时通过校验", () => {
    const result = ExerciseResultSchema.safeParse({ ...validResult, score: 85.5 });
    expect(result.success).toBe(true);
  });

  it("score 为字符串时校验失败", () => {
    const result = ExerciseResultSchema.safeParse({
      ...validResult,
      score: "100",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 category 字段时校验失败", () => {
    const { category, ...missing } = validResult;
    const result = ExerciseResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 exercises 字段时校验失败", () => {
    const { exercises, ...missing } = validResult;
    const result = ExerciseResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 userAnswers 字段时校验失败", () => {
    const { userAnswers, ...missing } = validResult;
    const result = ExerciseResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("缺少 score 字段时校验失败", () => {
    const { score, ...missing } = validResult;
    const result = ExerciseResultSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("exercises 内题目缺少必填字段时校验失败", () => {
    const result = ExerciseResultSchema.safeParse({
      ...validResult,
      exercises: [{ type: "fill", question: "test" }], // 缺少 answer 和 explanation
    });
    expect(result.success).toBe(false);
  });
});

/**
 * ExerciseTypeSchema 测试套件。
 *
 * 覆盖练习题型枚举的校验。
 */
describe("ExerciseTypeSchema", () => {
  it("接受 fill 枚举值", () => {
    expect(ExerciseTypeSchema.safeParse("fill").success).toBe(true);
  });

  it("接受 correct 枚举值", () => {
    expect(ExerciseTypeSchema.safeParse("correct").success).toBe(true);
  });

  it("接受 rewrite 枚举值", () => {
    expect(ExerciseTypeSchema.safeParse("rewrite").success).toBe(true);
  });

  it("拒绝无效的枚举值", () => {
    expect(ExerciseTypeSchema.safeParse("unknown").success).toBe(false);
    expect(ExerciseTypeSchema.safeParse("").success).toBe(false);
    expect(ExerciseTypeSchema.safeParse(123).success).toBe(false);
  });
});

/**
 * WordLevelSchema 和 ReviewStatusSchema 测试套件。
 *
 * 覆盖词汇等级和复习状态枚举的校验。
 */
describe("WordLevelSchema", () => {
  it("接受 CET-4", () => {
    expect(WordLevelSchema.safeParse("CET-4").success).toBe(true);
  });

  it("接受 CET-6", () => {
    expect(WordLevelSchema.safeParse("CET-6").success).toBe(true);
  });

  it("接受 TEM-4", () => {
    expect(WordLevelSchema.safeParse("TEM-4").success).toBe(true);
  });

  it("接受 TEM-8", () => {
    expect(WordLevelSchema.safeParse("TEM-8").success).toBe(true);
  });

  it("拒绝无效的等级值", () => {
    expect(WordLevelSchema.safeParse("GRE").success).toBe(false);
    expect(WordLevelSchema.safeParse("cet-4").success).toBe(false);
    expect(WordLevelSchema.safeParse("").success).toBe(false);
  });
});

describe("ReviewStatusSchema", () => {
  it("接受 new", () => {
    expect(ReviewStatusSchema.safeParse("new").success).toBe(true);
  });

  it("接受 learning", () => {
    expect(ReviewStatusSchema.safeParse("learning").success).toBe(true);
  });

  it("接受 mastered", () => {
    expect(ReviewStatusSchema.safeParse("mastered").success).toBe(true);
  });

  it("拒绝无效的状态值", () => {
    expect(ReviewStatusSchema.safeParse("reviewed").success).toBe(false);
    expect(ReviewStatusSchema.safeParse("").success).toBe(false);
    expect(ReviewStatusSchema.safeParse(0).success).toBe(false);
  });
});

/**
 * ListeningSentenceSchema 和 ListeningResultSchema 测试套件。
 */
describe("ListeningSentenceSchema", () => {
  it("校验合法的听力句子", () => {
    const result = ListeningSentenceSchema.safeParse({
      text: "Hello, how are you?",
      hint: "日常问候",
    });
    expect(result.success).toBe(true);
  });

  it("缺少 text 字段时校验失败", () => {
    const result = ListeningSentenceSchema.safeParse({ hint: "test" });
    expect(result.success).toBe(false);
  });

  it("缺少 hint 字段时校验失败", () => {
    const result = ListeningSentenceSchema.safeParse({ text: "test" });
    expect(result.success).toBe(false);
  });

  it("text 为非字符串时校验失败", () => {
    const result = ListeningSentenceSchema.safeParse({ text: 123, hint: "test" });
    expect(result.success).toBe(false);
  });
});

describe("ListeningResultSchema", () => {
  const validResult = {
    difficulty: "中级",
    topic: "日常对话",
    sentences: [{ text: "Hello.", hint: "问候" }],
    userInputs: ["Hello."],
    score: 90,
  };

  it("校验合法的听力结果", () => {
    const result = ListeningResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResult);
  });

  it("缺少 difficulty 字段时校验失败", () => {
    const { difficulty, ...missing } = validResult;
    expect(ListeningResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 topic 字段时校验失败", () => {
    const { topic, ...missing } = validResult;
    expect(ListeningResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 sentences 字段时校验失败", () => {
    const { sentences, ...missing } = validResult;
    expect(ListeningResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 userInputs 字段时校验失败", () => {
    const { userInputs, ...missing } = validResult;
    expect(ListeningResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 score 字段时校验失败", () => {
    const { score, ...missing } = validResult;
    expect(ListeningResultSchema.safeParse(missing).success).toBe(false);
  });

  it("score 为字符串时校验失败", () => {
    expect(ListeningResultSchema.safeParse({ ...validResult, score: "90" }).success).toBe(false);
  });
});

/**
 * SpeakingScoreSchema、WordAlignmentItemSchema、
 * SpeakingResultItemSchema 和 SpeakingResultSchema 测试套件。
 */
describe("WordAlignmentItemSchema", () => {
  it("校验合法的词级对齐项", () => {
    const result = WordAlignmentItemSchema.safeParse({
      word: "hello",
      ipa: "/həˈloʊ/",
      status: "correct",
    });
    expect(result.success).toBe(true);
  });

  it("接受 status 为 mispronounced", () => {
    const result = WordAlignmentItemSchema.safeParse({
      word: "world",
      ipa: "/wɜːrld/",
      status: "mispronounced",
    });
    expect(result.success).toBe(true);
  });

  it("接受 status 为 missed", () => {
    const result = WordAlignmentItemSchema.safeParse({
      word: "the",
      ipa: "/ðə/",
      status: "missed",
    });
    expect(result.success).toBe(true);
  });

  it("拒绝无效的 status 值", () => {
    const result = WordAlignmentItemSchema.safeParse({
      word: "hello",
      ipa: "/həˈloʊ/",
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 word 字段时校验失败", () => {
    const result = WordAlignmentItemSchema.safeParse({
      ipa: "/həˈloʊ/",
      status: "correct",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 status 字段时校验失败", () => {
    const result = WordAlignmentItemSchema.safeParse({
      word: "hello",
      ipa: "/həˈloʊ/",
    });
    expect(result.success).toBe(false);
  });
});

describe("SpeakingScoreSchema", () => {
  const validScore = {
    pronunciation: 85,
    grammar: 90,
    fluency: 80,
    overall: 85,
    feedback: "发音不错，注意连读。",
    wordAlignment: [{ word: "hello", ipa: "/həˈloʊ/", status: "correct" as const }],
  };

  it("校验合法的口语评分（含 wordAlignment）", () => {
    const result = SpeakingScoreSchema.safeParse(validScore);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validScore);
  });

  it("wordAlignment 省略时通过校验（optional）", () => {
    const { wordAlignment, ...withoutAlignment } = validScore;
    const result = SpeakingScoreSchema.safeParse(withoutAlignment);
    expect(result.success).toBe(true);
    expect(result.data?.wordAlignment).toBeUndefined();
  });

  it("wordAlignment 为空数组时通过校验", () => {
    const result = SpeakingScoreSchema.safeParse({
      ...validScore,
      wordAlignment: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.wordAlignment).toHaveLength(0);
  });

  it("缺少 pronunciation 字段时校验失败", () => {
    const { pronunciation, ...missing } = validScore;
    expect(SpeakingScoreSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 feedback 字段时校验失败", () => {
    const { feedback, ...missing } = validScore;
    expect(SpeakingScoreSchema.safeParse(missing).success).toBe(false);
  });

  it("分数为字符串时校验失败", () => {
    expect(SpeakingScoreSchema.safeParse({ ...validScore, pronunciation: "85" }).success).toBe(
      false,
    );
  });
});

describe("SpeakingResultItemSchema", () => {
  const validItem = {
    sentence: { text: "Hello, world.", translation: "你好，世界。" },
    transcription: "Hello world",
    score: {
      pronunciation: 80,
      grammar: 85,
      fluency: 75,
      overall: 80,
      feedback: "Good job.",
    },
    skipped: false,
  };

  it("校验合法的口语练习项（含 score）", () => {
    const result = SpeakingResultItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });

  it("score 为 null 时通过校验（.nullable()）", () => {
    const result = SpeakingResultItemSchema.safeParse({
      ...validItem,
      score: null,
    });
    expect(result.success).toBe(true);
    expect(result.data?.score).toBeNull();
  });

  it("skipped 为 true 时通过校验", () => {
    const result = SpeakingResultItemSchema.safeParse({
      ...validItem,
      skipped: true,
      score: null,
    });
    expect(result.success).toBe(true);
    expect(result.data?.skipped).toBe(true);
  });

  it("skipped 省略时通过校验（optional）", () => {
    const { skipped, ...withoutSkipped } = validItem;
    const result = SpeakingResultItemSchema.safeParse(withoutSkipped);
    expect(result.success).toBe(true);
    expect(result.data?.skipped).toBeUndefined();
  });

  it("缺少 sentence 字段时校验失败", () => {
    const { sentence, ...missing } = validItem;
    expect(SpeakingResultItemSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 transcription 字段时校验失败", () => {
    const { transcription, ...missing } = validItem;
    expect(SpeakingResultItemSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 score 字段时校验失败", () => {
    const { score, ...missing } = validItem;
    expect(SpeakingResultItemSchema.safeParse(missing).success).toBe(false);
  });
});

describe("SpeakingResultSchema", () => {
  const validResult = {
    difficulty: "中级",
    topic: "日常对话",
    sentences: [{ text: "Hello.", translation: "你好。" }],
    results: [
      {
        sentence: { text: "Hello.", translation: "你好。" },
        transcription: "Hello",
        score: {
          pronunciation: 80,
          grammar: 85,
          fluency: 75,
          overall: 80,
          feedback: "Good.",
        },
      },
    ],
    averageScore: 80,
  };

  it("校验合法的口语练习结果", () => {
    const result = SpeakingResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validResult);
  });

  it("缺少 difficulty 字段时校验失败", () => {
    const { difficulty, ...missing } = validResult;
    expect(SpeakingResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 topic 字段时校验失败", () => {
    const { topic, ...missing } = validResult;
    expect(SpeakingResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 sentences 字段时校验失败", () => {
    const { sentences, ...missing } = validResult;
    expect(SpeakingResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 results 字段时校验失败", () => {
    const { results, ...missing } = validResult;
    expect(SpeakingResultSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 averageScore 字段时校验失败", () => {
    const { averageScore, ...missing } = validResult;
    expect(SpeakingResultSchema.safeParse(missing).success).toBe(false);
  });

  it("averageScore 为字符串时校验失败", () => {
    expect(SpeakingResultSchema.safeParse({ ...validResult, averageScore: "80" }).success).toBe(
      false,
    );
  });
});

/**
 * CorrectionSchema 测试套件（单处纠错记录）。
 */
describe("CorrectionSchema", () => {
  const validCorrection = {
    original: "She go to school.",
    corrected: "She goes to school.",
    category: "主谓一致",
    explanation: "第三人称单数主语需用 goes",
  };

  it("校验合法的纠错记录", () => {
    const result = CorrectionSchema.safeParse(validCorrection);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validCorrection);
  });

  it("缺少 original 字段时校验失败", () => {
    const { original, ...missing } = validCorrection;
    expect(CorrectionSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 corrected 字段时校验失败", () => {
    const { corrected, ...missing } = validCorrection;
    expect(CorrectionSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 category 字段时校验失败", () => {
    const { category, ...missing } = validCorrection;
    expect(CorrectionSchema.safeParse(missing).success).toBe(false);
  });

  it("缺少 explanation 字段时校验失败", () => {
    const { explanation, ...missing } = validCorrection;
    expect(CorrectionSchema.safeParse(missing).success).toBe(false);
  });

  it("字段为非字符串时校验失败", () => {
    expect(CorrectionSchema.safeParse({ ...validCorrection, original: 123 }).success).toBe(false);
    expect(CorrectionSchema.safeParse({ ...validCorrection, category: null }).success).toBe(false);
  });
});
