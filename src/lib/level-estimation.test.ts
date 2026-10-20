import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@/types";
import type { BandSample, LevelSample, ScoredSample } from "./level-estimation";
import {
  buildSuggestions,
  estimateFromBands,
  estimateFromLevels,
  estimateFromScored,
  isUsablePlacementQuestion,
  SKILL_LABELS,
  SKILL_ORDER,
  type SkillEstimate,
  scorePlacement,
} from "./level-estimation";
import { buildSkillEstimates, type LevelEstimationInputs } from "./level-estimation-samples";
import { LEVEL_CODES, type LevelCode } from "./levels";

/** 构造 SkillEstimate 的测试助手 */
function est(
  skill: SkillEstimate["skill"],
  level: LevelCode,
  confidence: SkillEstimate["confidence"],
): SkillEstimate {
  return {
    skill,
    level,
    index: LEVEL_CODES.indexOf(level),
    confidence,
    sampleSize: 6,
    avgScore: 80,
  };
}

describe("estimateFromScored", () => {
  it("多次同级样本保持该级别", () => {
    const samples: ScoredSample[] = [
      { level: "B1", score: 80 },
      { level: "B1", score: 70 },
      { level: "B1", score: 75 },
    ];
    expect(estimateFromScored("listening", samples)?.level).toBe("B1");
  });

  it("高分上调一档(75→90 分)", () => {
    const samples: ScoredSample[] = [
      { level: "B1", score: 95 },
      { level: "B1", score: 90 },
      { level: "B1", score: 92 },
    ];
    expect(estimateFromScored("listening", samples)?.level).toBe("B1+");
  });

  it("低分下调一档", () => {
    const samples: ScoredSample[] = [
      { level: "B2", score: 55 },
      { level: "B2", score: 60 },
      { level: "B2", score: 50 },
    ];
    expect(estimateFromScored("speaking", samples)?.level).toBe("B1+");
  });

  it("得分为 75 时不调整", () => {
    const samples: ScoredSample[] = [{ level: "B2", score: 75 }];
    expect(estimateFromScored("exercise", samples)?.level).toBe("B2");
  });

  it("调整钳制 ±1 档:满分也不跳两级", () => {
    const samples: ScoredSample[] = [{ level: "A2", score: 100 }];
    expect(estimateFromScored("exercise", samples)?.level).toBe("B1");
  });

  it("score=0 也按 -1 档下限钳制(不继续下调)", () => {
    // (0-75)/15 = -5 → 钳制到 -1：一次极端低分只降一档
    const samples: ScoredSample[] = [{ level: "B2", score: 0 }];
    expect(estimateFromScored("exercise", samples)?.level).toBe("B1+");
  });

  it("时间衰减:新样本权重高于旧样本", () => {
    // 旧 B2 ×5 + 新 A2 ×1 → 加权档位 ≈2.28,从 B2(3)被拉低一档到 B1+(2)
    const samples: ScoredSample[] = [
      { level: "A2", score: 75 },
      { level: "B2", score: 75 },
      { level: "B2", score: 75 },
      { level: "B2", score: 75 },
      { level: "B2", score: 75 },
      { level: "B2", score: 75 },
    ];
    const estimate = estimateFromScored("exercise", samples);
    expect(estimate?.level).toBe("B1+");
  });

  it("空样本返回 null", () => {
    expect(estimateFromScored("listening", [])).toBeNull();
  });

  it("样本量决定置信度:计分技能 ≥8 高 / ≥4 中 / 更少低", () => {
    const make = (n: number): ScoredSample[] =>
      Array.from({ length: n }, () => ({ level: "B1" as const, score: 75 }));
    expect(estimateFromScored("listening", make(8))?.confidence).toBe("high");
    expect(estimateFromScored("listening", make(4))?.confidence).toBe("medium");
    expect(estimateFromScored("listening", make(3))?.confidence).toBe("low");
  });
});

describe("estimateFromBands / estimateFromLevels", () => {
  it("写作 band 序列取加权档位,置信度阈值独立(≥6 高无得分故封顶 medium)", () => {
    const samples: BandSample[] = [
      { band: "B2" },
      { band: "B1+" },
      { band: "B1+" },
      { band: "B1+" },
      { band: "B1+" },
      { band: "B1+" },
    ];
    const estimate = estimateFromBands(samples);
    expect(estimate?.skill).toBe("writing");
    expect(estimate?.level).toBe("B1+");
    expect(estimate?.confidence).toBe("medium");
    expect(estimate?.avgScore).toBeNull();
  });

  it("阅读级别序列估计,levels-only 置信度封顶 medium", () => {
    const samples: LevelSample[] = Array.from({ length: 10 }, () => ({ level: "B2" as const }));
    const estimate = estimateFromLevels(samples);
    expect(estimate?.skill).toBe("reading");
    expect(estimate?.level).toBe("B2");
    expect(estimate?.confidence).toBe("medium");
  });

  it("单样本 band/levels 置信度为 low(无得分证据,样本量也不足)", () => {
    expect(estimateFromBands([{ band: "B2" }])?.confidence).toBe("low");
    expect(estimateFromLevels([{ level: "B2" }])?.confidence).toBe("low");
  });

  it("空样本返回 null", () => {
    expect(estimateFromBands([])).toBeNull();
    expect(estimateFromLevels([])).toBeNull();
  });
});

describe("buildSuggestions", () => {
  it("单一技能达标给 upgrade-skill + practice 建议", () => {
    const suggestions = buildSuggestions("B1", [est("listening", "B2", "medium")]);
    expect(suggestions.map((s) => s.kind)).toEqual(["upgrade-skill", "practice"]);
    expect(suggestions[0].skill).toBe("listening");
    expect(suggestions[1].targetLevel).toBe("B1+");
  });

  it("practice 文案不叠字:exercise 技能为「下次练习选」而非「练习练习」", () => {
    // f16：旧模板 `建议${SKILL_LABELS[skill]}练习选择` 与 exercise 的标签
    // 「练习」拼接出病句「建议练习练习选择」；新模板以「下次…选」收口
    const suggestions = buildSuggestions("B1", [est("exercise", "B2", "medium")]);
    const practice = suggestions.find((s) => s.kind === "practice");
    expect(practice?.text).toBe("循序渐进:建议下次练习选「挑战」档(B1+)");
    expect(practice?.text).not.toContain("练习练习");
    expect(practice?.text).toContain("下次练习选");
  });

  it("两个技能达标升级为整体 upgrade-global,目标取最低达标档(保守爬坡)", () => {
    const suggestions = buildSuggestions("B1", [
      est("listening", "B2", "medium"),
      est("speaking", "B2+", "high"),
    ]);
    const global = suggestions.find((s) => s.kind === "upgrade-global");
    expect(global).toBeDefined();
    expect(global?.targetLevel).toBe("B2");
  });

  it("低置信度估计不触发建议", () => {
    expect(buildSuggestions("B1", [est("listening", "C1", "low")])).toHaveLength(0);
  });

  it("估计低于当前 2 档的技能 ≥2 时提示降档", () => {
    const suggestions = buildSuggestions("B2", [
      est("listening", "A2", "medium"),
      est("speaking", "A2", "high"),
    ]);
    const hint = suggestions.find((s) => s.kind === "downgrade-hint");
    expect(hint?.targetLevel).toBe("B1+");
  });

  it("C1 时不再产生 practice 建议(无更高档)", () => {
    const suggestions = buildSuggestions("C1", [est("listening", "C1", "high")]);
    expect(suggestions.find((s) => s.kind === "practice")).toBeUndefined();
  });

  it("无估计/全部同级时返回空", () => {
    expect(buildSuggestions("B1", [])).toHaveLength(0);
    expect(buildSuggestions("B1", [est("writing", "B1", "high")])).toHaveLength(0);
  });
});

describe("isUsablePlacementQuestion", () => {
  const valid = { band: "B1", answer: "has", options: ["have", "has", "had", "having"] };

  it("合法题通过", () => {
    expect(isUsablePlacementQuestion(valid)).toBe(true);
  });

  it("band 非法/选项数不为 4/答案不在选项中被拒", () => {
    expect(isUsablePlacementQuestion({ ...valid, band: "B3" })).toBe(false);
    expect(isUsablePlacementQuestion({ ...valid, options: ["a", "b", "c"] })).toBe(false);
    expect(isUsablePlacementQuestion({ ...valid, answer: "was" })).toBe(false);
  });
});

describe("scorePlacement", () => {
  /** 生成每档 2 题(共 12 题)的题目表,answer 恒为第一项 */
  const makeQuestions = (bands: readonly string[]) =>
    bands.map((band) => ({
      band,
      answer: `${band}-correct`,
      options: [`${band}-correct`, `${band}-wrong1`, `${band}-wrong2`, `${band}-wrong3`],
      question: `q(${band})`,
    }));

  it("全部答对 → 最高档 C1", () => {
    const qs = makeQuestions(LEVEL_CODES.flatMap((b) => [b, b]));
    const answers = qs.map((q) => q.answer);
    const score = scorePlacement(qs, answers);
    expect(score.estimated).toBe("C1");
    expect(score.totalCorrect).toBe(12);
    expect(score.perBand).toHaveLength(6);
  });

  it("前两档全对、B1+ 全错 → 估计停在 B1", () => {
    const qs = makeQuestions([
      "A2",
      "A2",
      "B1",
      "B1",
      "B1+",
      "B1+",
      "B2",
      "B2",
      "B2+",
      "B2+",
      "C1",
      "C1",
    ]);
    const answers = qs.map((q, i) =>
      q.band === "A2" || q.band === "B1" ? q.answer : `wrong-${i}`,
    );
    const score = scorePlacement(qs, answers);
    // A2 2/2、B1 4/4 累计达标;B1+ 累计 4/6 = 0.67 仍达标!
    // B2 累计 4/8 = 0.5 不达标 → 估计 B1+
    expect(score.estimated).toBe("B1+");
  });

  it("全部答错 → 回落 A2", () => {
    const qs = makeQuestions(LEVEL_CODES.flatMap((b) => [b, b]));
    const score = scorePlacement(
      qs,
      qs.map(() => null),
    );
    expect(score.estimated).toBe("A2");
    expect(score.totalCorrect).toBe(0);
  });

  it("无效题被剔除且不计入分母", () => {
    const qs = [
      ...makeQuestions(["A2", "A2"]),
      { band: "X9", answer: "y", options: ["y", "n", "m", "l"], question: "bad band" },
      {
        band: "B1",
        answer: "ghost",
        options: ["a", "b", "c", "d"],
        question: "answer not in options",
      },
    ];
    const score = scorePlacement(
      qs,
      qs.map((q) => q.answer),
    );
    expect(score.totalCount).toBe(2);
    expect(score.totalCorrect).toBe(2);
    expect(score.estimated).toBe("A2"); // 仅 A2 档有有效题
  });

  it("未作答(null)计为错误", () => {
    const qs = makeQuestions(["A2", "A2"]);
    const score = scorePlacement(qs, [qs[0].answer, null]);
    expect(score.totalCorrect).toBe(1);
    // 累计 1/2 = 0.5 < 0.6 → 未达标,回落 A2 恰为本档
    expect(score.estimated).toBe("A2");
  });
});

describe("SKILL_ORDER", () => {
  /** 五技能各一条合法样本(B1/75 分),喂给引擎的完整输入 */
  function fiveSkillInputs(): LevelEstimationInputs {
    const rec = (id: number, type: HistoryRecord["type"]): HistoryRecord => ({
      id,
      type,
      input_text: "t",
      result: "",
      graph_data: null,
      created_at: "2026-01-01 00:00:00",
      difficulty_level: "B1",
    });
    return {
      correct: [
        {
          record: rec(1, "correct"),
          result: {
            corrected_text: "t",
            corrections: [],
            summary: "s",
            level_estimate: { band: "B1", rationale: "r" },
          },
        },
      ],
      reading: [rec(2, "reading")],
      exercise: [
        {
          record: rec(3, "exercise"),
          result: {
            category: "时态错误",
            exercises: [{ type: "fill", question: "q", answer: "a", explanation: "e" }],
            userAnswers: ["a"],
            score: 1,
          },
        },
      ],
      listening: [
        {
          record: rec(4, "listening"),
          result: {
            difficulty: "B1",
            topic: "topic",
            sentences: [{ text: "s", hint: "h" }],
            userInputs: ["s"],
            score: 1,
          },
        },
      ],
      speaking: [
        {
          record: rec(5, "speaking"),
          result: {
            difficulty: "B1",
            topic: "topic",
            sentences: [{ text: "s", translation: "译" }],
            results: [
              {
                sentence: { text: "s", translation: "译" },
                transcription: "s",
                score: { pronunciation: 75, grammar: 75, fluency: 75, overall: 75, feedback: "f" },
              },
            ],
            averageScore: 75,
          },
        },
      ],
    };
  }

  it("固定为 写作/阅读/练习/听力/口语 五项", () => {
    expect(SKILL_ORDER).toEqual(["writing", "reading", "exercise", "listening", "speaking"]);
  });

  it("与 SKILL_LABELS 的键集合一致(EstimatableSkill 扩展时强制补顺序项)", () => {
    // 字面量类型下 SKILL_ORDER 漏项仍是合法子集不报错,靠此断言兜底
    expect([...SKILL_ORDER].sort()).toEqual(Object.keys(SKILL_LABELS).sort());
  });

  it("引擎 buildSkillEstimates 的产出顺序即 SKILL_ORDER(展示顺序单一来源)", () => {
    // LevelCard 徽章行与 LevelProgressCard 雷达轴都按 SKILL_ORDER 渲染,
    // 引擎按 写作/阅读/练习/听力/口语 段落依次 push 估计——两边漂移时此断言失败
    const { estimates } = buildSkillEstimates(fiveSkillInputs(), "B1");
    expect(estimates).toHaveLength(SKILL_ORDER.length);
    expect(estimates.map((e) => e.skill)).toEqual(SKILL_ORDER);
  });
});
