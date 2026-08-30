import { describe, expect, it } from "vitest";
import {
  historySummarizers,
  scoreOverviews,
  sessionScoreView,
  summarizeRecord,
} from "./history-presentation";
import { typeConfig } from "./type-config";

/**
 * history-presentation 注册表测试套件。
 *
 * 该模块是"记录类型 → 展示知识"的单一映射点（时间线摘要、得分概览卡主题、
 * 近期会话分数文案），被 DashboardPage / AnalyticsPage / HistoryDetailPage 共用。
 *
 * 测试重点：
 * 1. 运行时键完整性：historySummarizers 覆盖 typeConfig 的全部类型
 *    （编译期穷举由 Record 注解保证，此处防运行时清单漂移）
 * 2. 各类型 summarize 的成功路径与解析失败降级（→ null）
 * 3. 概览卡 content 文案与 theme 视觉（图标与 typeConfig 同源）
 * 4. 近期会话分数徽章的类型分支与缺字段降级
 */

/** 构造一段合法的写作批改 result JSON */
const writingJson = JSON.stringify({
  corrected_text: "I went to school.",
  corrections: [
    { original: "goed", corrected: "went", category: "时态错误", explanation: "过去式" },
    { original: "a", corrected: "an", category: "冠词错误", explanation: "元音前用 an" },
  ],
  summary: "整体不错，注意时态。",
});

/** 构造一段合法的练习 result JSON */
const exerciseJson = JSON.stringify({
  category: "时态错误",
  exercises: [
    { type: "fill", question: "q1", answer: "a", explanation: "" },
    { type: "fill", question: "q2", answer: "b", explanation: "" },
    { type: "fill", question: "q3", answer: "c", explanation: "" },
    { type: "fill", question: "q4", answer: "d", explanation: "" },
    { type: "fill", question: "q5", answer: "e", explanation: "" },
  ],
  userAnswers: ["a", "b", "c", "x", "x"],
  score: 3,
});

/** 构造一段合法的听力 result JSON */
const listeningJson = JSON.stringify({
  difficulty: "中级",
  topic: "日常对话",
  sentences: [
    { text: "Hello there.", hint: "问候" },
    { text: "How are you?", hint: "寒暄" },
  ],
  userInputs: ["Hello there.", "How are you?"],
  score: 2,
});

/** 构造一段合法的口语 result JSON */
const speakingJson = JSON.stringify({
  difficulty: "高级",
  topic: "商务英语",
  sentences: [{ text: "Looking forward to it.", translation: "期待中。" }],
  results: [
    {
      sentence: { text: "Looking forward to it.", translation: "期待中。" },
      transcription: "Looking forward to it.",
      score: { pronunciation: 90, grammar: 88, fluency: 92, overall: 90, feedback: "流利" },
    },
  ],
  averageScore: 90,
});

describe("historySummarizers 键完整性", () => {
  it("runtime keys cover exactly the typeConfig keys (all HistoryRecord types)", () => {
    // typeConfig 是 history.type 合法值集合的运行时权威（isHistoryType 同源），
    // 注册表键集合必须与其完全一致：多出（拼错字面量）或遗漏都会在此失败
    expect(Object.keys(historySummarizers).sort()).toEqual(Object.keys(typeConfig).sort());
  });
});

describe("writing/correct summarize", () => {
  /** summary 超过 50 字的写作 result：验证预览截断 */
  const longSummaryJson = JSON.stringify({
    corrected_text: "I went to school.",
    corrections: [],
    summary: "这".repeat(60),
  });

  it("returns error count and summary preview for a valid result", () => {
    expect(historySummarizers.correct("fallback", writingJson)).toEqual({
      preview: "整体不错，注意时态。",
      scoreText: "2 处错误",
    });
  });

  it("shares one implementation between correct and writing", () => {
    expect(historySummarizers.writing("fallback", writingJson)).toEqual(
      historySummarizers.correct("fallback", writingJson),
    );
  });

  it("truncates long summaries to 50 chars", () => {
    const summary = historySummarizers.writing("fallback", longSummaryJson);
    expect(summary?.preview?.length).toBe(50);
    expect(summary?.scoreText).toBe("0 处错误");
  });

  it("falls back to input preview when summary is empty string", () => {
    const json = JSON.stringify({ ...JSON.parse(writingJson), summary: "" });
    expect(historySummarizers.correct("输入预览", json)?.preview).toBe("输入预览");
  });

  it.each([["not json at all"], ["{}"], ['{"corrections": "oops"}'], [undefined]])(
    "returns null on unparseable/missing result (%s)",
    (result) => {
      expect(historySummarizers.correct("fallback", result)).toBeNull();
    },
  );
});

describe("reading summarize", () => {
  it("always yields no structured summary (markdown 长文)", () => {
    expect(historySummarizers.reading("fallback", "## 段落解析\n内容")).toBeNull();
    expect(historySummarizers.reading("fallback")).toBeNull();
  });
});

describe("exercise summarize", () => {
  it("returns category training preview and score/total", () => {
    expect(historySummarizers.exercise("fallback", exerciseJson)).toEqual({
      preview: "时态错误 训练",
      scoreText: "3/5",
    });
  });

  it.each([["broken"], [undefined]])(
    "returns null on unparseable/missing result (%s)",
    (result) => {
      expect(historySummarizers.exercise("fallback", result)).toBeNull();
    },
  );
});

describe("listening summarize", () => {
  it("returns topic preview and score/total", () => {
    expect(historySummarizers.listening("fallback", listeningJson)).toEqual({
      preview: "日常对话",
      scoreText: "2/2",
    });
  });

  it("falls back to input preview when topic is an empty string", () => {
    const json = JSON.stringify({ ...JSON.parse(listeningJson), topic: "" });
    expect(historySummarizers.listening("输入预览", json)?.preview).toBe("输入预览");
  });

  it("returns null on unparseable result", () => {
    expect(historySummarizers.listening("fallback", "{{{")).toBeNull();
  });
});

describe("speaking summarize", () => {
  it("returns topic (difficulty) preview and average score text", () => {
    expect(historySummarizers.speaking("fallback", speakingJson)).toEqual({
      preview: "商务英语 (高级)",
      scoreText: "平均 90 分",
    });
  });

  it("returns null on structurally invalid result", () => {
    expect(historySummarizers.speaking("fallback", '{"topic": 1}')).toBeNull();
  });
});

describe("summarizeRecord 包装层", () => {
  function makeRecord(type: keyof typeof historySummarizers, inputText: string) {
    return { type, input_text: inputText };
  }

  it("delegates to the per-type summarizer when parsing succeeds", () => {
    const record = makeRecord("exercise", "practice text");
    expect(summarizeRecord(record, exerciseJson)).toEqual({
      preview: "时态错误 训练",
      scoreText: "3/5",
    });
  });

  it("falls back to truncated input preview and null scoreText on parse failure", () => {
    const record = makeRecord("exercise", "practice text");
    expect(summarizeRecord(record, "garbage")).toEqual({
      preview: "practice text",
      scoreText: null,
    });
  });

  it("falls back when result is missing entirely", () => {
    const record = makeRecord("listening", "dictation input");
    expect(summarizeRecord(record)).toEqual({ preview: "dictation input", scoreText: null });
  });

  it("truncates inputs longer than 50 chars with ellipsis", () => {
    const longInput = "a".repeat(60);
    const record = makeRecord("reading", longInput);
    expect(summarizeRecord(record)).toEqual({
      preview: `${"a".repeat(50)}...`,
      scoreText: null,
    });
  });
});

describe("scoreOverviews 概览卡配置", () => {
  it("themes reuse the typeConfig icons (视觉同源，不重复声明)", () => {
    expect(scoreOverviews.exercise.theme.icon).toBe(typeConfig.exercise.icon);
    expect(scoreOverviews.listening.theme.icon).toBe(typeConfig.listening.icon);
    expect(scoreOverviews.speaking.theme.icon).toBe(typeConfig.speaking.icon);
  });

  it("exercise content builds title/score/unit from parsed data", () => {
    const parsed = JSON.parse(exerciseJson);
    expect(scoreOverviews.exercise.content(parsed)).toEqual({
      title: "训练类别：时态错误",
      score: "3/5",
      unit: "正确",
    });
    expect(scoreOverviews.exercise.theme.containerClass).toBe(
      "border-orange-500/40 bg-orange-500/5",
    );
  });

  it("listening content builds title/score/unit from parsed data", () => {
    const parsed = JSON.parse(listeningJson);
    expect(scoreOverviews.listening.content(parsed)).toEqual({
      title: "听力练习：日常对话 (中级)",
      score: "2/2",
      unit: "正确",
    });
    expect(scoreOverviews.listening.theme.containerClass).toBe("border-cyan-500/40 bg-cyan-500/5");
  });

  it("speaking content builds average-score card from parsed data", () => {
    const parsed = JSON.parse(speakingJson);
    expect(scoreOverviews.speaking.content(parsed)).toEqual({
      title: "口语练习：商务英语 (高级)",
      score: "90",
      unit: "平均分",
    });
    expect(scoreOverviews.speaking.theme.containerClass).toBe("border-rose-500/40 bg-rose-500/5");
  });
});

describe("sessionScoreView 会话分数徽章", () => {
  it("writing/correct show category chip and destructive error count", () => {
    expect(sessionScoreView("correct", { topCategory: "时态错误", total: 3 })).toEqual({
      categoryChip: "时态错误",
      text: "3 处错误",
      tone: "destructive",
    });
  });

  it("writing without topCategory renders nothing (原 BUG-4 行为保持)", () => {
    expect(sessionScoreView("writing", { total: 3 })).toBeNull();
  });

  it("exercise/listening need both score and total", () => {
    expect(sessionScoreView("exercise", { score: 8, total: 10 })).toEqual({
      text: "8/10",
      tone: "primary",
    });
    expect(sessionScoreView("listening", { score: 8 })).toBeNull();
    expect(sessionScoreView("listening", {})).toBeNull();
  });

  it("speaking shows score with 分 suffix", () => {
    expect(sessionScoreView("speaking", { score: 85 })).toEqual({ text: "85分", tone: "primary" });
    expect(sessionScoreView("speaking", {})).toBeNull();
  });

  it("reading has no score display", () => {
    expect(sessionScoreView("reading", { score: 1, total: 1 })).toBeNull();
  });
});
