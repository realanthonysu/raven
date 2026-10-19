/**
 * 级别估计核心 —— 被动定级(Phase 4)与分技能级别雷达(Phase 3)共用的确定性引擎。
 *
 * 全部为纯函数(无 I/O),输入是调用方归一化好的样本(见各接口注释),
 * 输出估计级别、置信度与升级建议。算法参数集中在文件头的可调常量区。
 *
 * 数据流:
 * - 主动定级:AI 定级测试 → scorePlacement() 规则计分 → 建议级别
 * - 被动定级:练习/听力/口语的 (难度级别, 得分) 样本 → estimateFromScored()
 *   写作的估级 band 样本 → estimateFromBands();阅读的练习级别样本 → estimateFromLevels()
 * - 建议:buildSuggestions(当前级别, 各技能估计) → 升级/降档/+i 练习建议
 *
 * 设计原则:估计透明可解释(规则确定、无 LLM 参与判定)、样本不足时输出低置信度
 * 而非硬猜、建议只做显式推荐(LevelCard/Analytics 一键应用),不做隐形自动调级。
 */

import { LEVEL_CODES, type LevelCode } from "@/lib/levels";

// ============================================================================
// 可调算法常量
// ============================================================================

/** 时间衰减:样本按新→旧排列,第 i 个样本权重 ×0.85^i(新表现权重更高) */
const RECENCY_DECAY = 0.85;
/** 得分锚点:加权平均分每高于 75 分 15 分,估计级别上调一档(反之亦然) */
const SCORE_TARGET = 75;
const SCORE_SPAN = 15;
/** 得分调整的上下限(±1 档),防止一次极端得分跳两级 */
const SCORE_ADJUST_LIMIT = 1;
/** 置信度样本量阈值:计分技能 ≥8 高 / ≥4 中;band 与级别技能(无得分证据)
 *  ≥6 中 / ≥3 低,封顶 medium —— 缺少得分维度时不给高置信度 */
const CONF_HIGH_SCORED = 8;
const CONF_MEDIUM_SCORED = 4;
const CONF_HIGH_BAND = 6;
const CONF_MEDIUM_BAND = 3;
/** 定级测试计分:低→高累计正确率达到该阈值即认定"该档达标" */
const PLACEMENT_PASS_RATE = 0.6;
/** 升级建议触发:估计档 ≥ 当前档 +1 且置信度非 low 的技能数 */
const GLOBAL_UPGRADE_SKILLS = 2;
/** 降档提示触发:估计档 ≤ 当前档 -2 且置信度非 low 的技能数 */
const DOWNGRADE_SKILLS = 2;

// ============================================================================
// 类型
// ============================================================================

/** 可估计的五项技能(与 5 个学习页面一一对应) */
export type EstimatableSkill = "writing" | "reading" | "exercise" | "listening" | "speaking";

/** 技能展示名(建议文案用) */
export const SKILL_LABELS: Record<EstimatableSkill, string> = {
  writing: "写作",
  reading: "阅读",
  exercise: "练习",
  listening: "听力",
  speaking: "口语",
};

export type EstimationConfidence = "low" | "medium" | "high";

/** 带得分的样本:练习(百分制归一后)、听力(0-100)、口语(0-100 平均分) */
export interface ScoredSample {
  level: LevelCode;
  /** 0-100 百分制得分 */
  score: number;
}

/** band 样本:写作批改的 level_estimate.band */
export interface BandSample {
  band: LevelCode;
}

/** 级别样本:阅读记录的 difficulty_level(无得分,仅代表练习难度) */
export interface LevelSample {
  level: LevelCode;
}

/** 估计中间结果(内部),SkillEstimate 的去技能化版本 */
interface RawEstimate {
  /** 估计级别在 LEVEL_CODES 中的下标 */
  index: number;
  confidence: EstimationConfidence;
  sampleSize: number;
  /** 样本加权平均得分(0-100);无得分维度(写作 band/阅读)为 null */
  avgScore: number | null;
}

/** 单技能的最终估计 */
export interface SkillEstimate extends RawEstimate {
  skill: EstimatableSkill;
  level: LevelCode;
}

// ============================================================================
// 估计核心
// ============================================================================

/**
 * 加权估计:index 序列(按新→旧)按 RECENCY_DECAY 衰减求均值;
 * 提供得分序列时按 (加权均分 - 75) / 15 四舍五入(±1 档钳制)微调。
 */
function weightedEstimate(indices: number[], scores?: number[]): RawEstimate | null {
  if (indices.length === 0) return null;
  let wSum = 0;
  let idxSum = 0;
  let scoreSum = 0;
  let scoreWeight = 0;
  for (let i = 0; i < indices.length; i++) {
    const w = RECENCY_DECAY ** i;
    wSum += w;
    idxSum += w * indices[i];
    if (scores) {
      scoreSum += w * scores[i];
      scoreWeight += w;
    }
  }
  const baseIdx = idxSum / wSum;
  const avgScore = scores && scoreWeight > 0 ? scoreSum / scoreWeight : null;
  const adjust =
    avgScore === null
      ? 0
      : Math.max(
          -SCORE_ADJUST_LIMIT,
          Math.min(SCORE_ADJUST_LIMIT, Math.round((avgScore - SCORE_TARGET) / SCORE_SPAN)),
        );
  return {
    index: Math.max(0, Math.min(LEVEL_CODES.length - 1, Math.round(baseIdx + adjust))),
    confidence: confidenceFor(indices.length, scores !== undefined),
    sampleSize: indices.length,
    avgScore,
  };
}

/** 样本量 → 置信度(levels-only 维度封顶 medium:无得分证据弱一档) */
function confidenceFor(n: number, scored: boolean): EstimationConfidence {
  if (scored) {
    if (n >= CONF_HIGH_SCORED) return "high";
    if (n >= CONF_MEDIUM_SCORED) return "medium";
  } else {
    if (n >= CONF_HIGH_BAND) return "medium";
    if (n >= CONF_MEDIUM_BAND) return "low";
  }
  return "low";
}

/**
 * 从带得分样本估计(练习/听力/口语 —— 由 skill 参数区分)。
 * 样本必须按新 → 旧排列(时间衰减假设),调用方负责排序与百分制归一。
 */
export function estimateFromScored(
  skill: EstimatableSkill,
  samples: readonly ScoredSample[],
): SkillEstimate | null {
  const raw = weightedEstimate(
    samples.map((s) => LEVEL_CODES.indexOf(s.level)),
    samples.map((s) => s.score),
  );
  return raw ? toEstimate(skill, raw) : null;
}

function toEstimate(skill: EstimatableSkill, raw: RawEstimate): SkillEstimate {
  return { skill, ...raw, level: LEVEL_CODES[raw.index] };
}

/**
 * 从 band 样本估计(写作 level_estimate.band,无得分微调)。
 * 样本必须按新 → 旧排列。
 */
export function estimateFromBands(samples: readonly BandSample[]): SkillEstimate | null {
  const raw = weightedEstimate(samples.map((s) => LEVEL_CODES.indexOf(s.band)));
  return raw && toEstimate("writing", raw);
}

/**
 * 从级别样本估计(阅读 difficulty_level,仅代表练习难度偏好,置信度封顶 medium)。
 * 样本必须按新 → 旧排列。
 */
export function estimateFromLevels(samples: readonly LevelSample[]): SkillEstimate | null {
  const raw = weightedEstimate(samples.map((s) => LEVEL_CODES.indexOf(s.level)));
  return raw && toEstimate("reading", raw);
}

// ============================================================================
// 升级建议
// ============================================================================

export type SuggestionKind = "upgrade-skill" | "upgrade-global" | "downgrade-hint" | "practice";

/** 一条级别建议:显式推荐,由用户在 LevelCard/Analytics 一键应用 */
export interface LevelUpSuggestion {
  kind: SuggestionKind;
  skill?: EstimatableSkill;
  targetLevel: LevelCode;
  /** 面向用户的完整建议文案 */
  text: string;
}

/**
 * 由"当前级别 + 各技能估计"生成建议列表(确定性规则,无 LLM)。
 *
 * 规则:
 * - upgrade-skill:置信度非 low 且估计 ≥ 当前+1 的技能(最多列 2 条,取差距最大者)
 * - upgrade-global:达标技能 ≥2 时给出整体升级建议,目标取达标技能中的最低估计(保守爬坡)
 * - downgrade-hint:估计 ≤ 当前-2 的技能 ≥2 时提示降档,目标 = 当前档 -1
 * - practice(+i):对差距最大的达标技能,建议下次练习选「挑战」档
 */
export function buildSuggestions(
  current: LevelCode,
  estimates: readonly SkillEstimate[],
): LevelUpSuggestion[] {
  const curIdx = LEVEL_CODES.indexOf(current);
  const qualified = estimates
    .filter((e) => e.confidence !== "low" && e.index - curIdx >= 1)
    .sort((a, b) => b.index - a.index);
  const struggling = estimates.filter((e) => e.confidence !== "low" && curIdx - e.index >= 2);

  const suggestions: LevelUpSuggestion[] = [];

  if (qualified.length >= GLOBAL_UPGRADE_SKILLS) {
    // 保守爬坡:整体目标取达标技能中的最低估计档
    const target = LEVEL_CODES[Math.min(...qualified.map((e) => e.index))];
    suggestions.push({
      kind: "upgrade-global",
      targetLevel: target,
      text: `${qualified.map((e) => SKILL_LABELS[e.skill]).join("、")}已稳定在 ${target} 档,建议整体升级到 ${target}`,
    });
  } else {
    for (const e of qualified.slice(0, 2)) {
      suggestions.push({
        kind: "upgrade-skill",
        skill: e.skill,
        targetLevel: LEVEL_CODES[e.index],
        text: `${SKILL_LABELS[e.skill]}已在 ${LEVEL_CODES[e.index]} 档稳定表现,建议升级`,
      });
    }
  }

  if (qualified.length > 0 && curIdx < LEVEL_CODES.length - 1) {
    const top = qualified[0];
    const target = LEVEL_CODES[Math.min(curIdx + 1, LEVEL_CODES.length - 1)];
    suggestions.push({
      kind: "practice",
      skill: top.skill,
      targetLevel: target,
      text: `循序渐进:建议${SKILL_LABELS[top.skill]}练习选择「挑战」档(${target})`,
    });
  }

  if (struggling.length >= DOWNGRADE_SKILLS) {
    const target = LEVEL_CODES[Math.max(0, curIdx - 1)];
    suggestions.push({
      kind: "downgrade-hint",
      targetLevel: target,
      text: `近期表现明显低于当前级别,建议降一档到 ${target} 巩固基础`,
    });
  }

  return suggestions;
}

// ============================================================================
// AI 定级测试计分(确定性规则)
// ============================================================================

/** 定级测试题的最小契约(与 PlacementQuestionSchema 字段兼容) */
export interface PlacementQuestionLike {
  band: string;
  answer: string;
  options: readonly string[];
}

export interface PlacementBandScore {
  band: LevelCode;
  correct: number;
  total: number;
}

export interface PlacementScore {
  /** 各档(仅含有有效题的档,按 LEVEL_CODES 升序)的答对/题数 */
  perBand: PlacementBandScore[];
  /** 规则推导出的建议级别 */
  estimated: LevelCode;
  totalCorrect: number;
  totalCount: number;
}

/**
 * 校验单题有效性:band 合法、恰好 4 个选项、answer 与某个选项完全一致。
 * LLM 输出不满足任一条的题直接剔除(不计入分母)。
 */
export function isUsablePlacementQuestion(q: PlacementQuestionLike): boolean {
  return (
    (LEVEL_CODES as readonly string[]).includes(q.band) &&
    q.options.length === 4 &&
    q.options.includes(q.answer)
  );
}

/**
 * 定级测试计分:低 → 高累计正确率规则。
 *
 * 对 LEVEL_CODES 升序的每个档 b:统计 band ≤ b 的全部有效题的累计正确率,
 * ≥ PLACEMENT_PASS_RATE(0.6)即认定"该档达标";估计级别 = 最高的达标档。
 * 所有档都不达标时回落 A2。答案按选项原文精确匹配(answer 与用户所选完全一致)。
 *
 * @param questions 测试题(含无效题会被剔除)
 * @param userAnswers 与 questions 等长的用户答案(null = 未作答,计为错误)
 */
export function scorePlacement<T extends PlacementQuestionLike>(
  questions: readonly T[],
  userAnswers: readonly (string | null)[],
): PlacementScore {
  const usable = questions
    .map((q, i) => ({ q, answer: userAnswers[i] ?? null }))
    .filter(({ q }) => isUsablePlacementQuestion(q));

  const totalCorrect = usable.filter(({ q, answer }) => answer === q.answer).length;

  // 按档聚合;band 档序以 LEVEL_CODES 为准
  const perBand: PlacementBandScore[] = [];
  for (const band of LEVEL_CODES) {
    const inBand = usable.filter(({ q }) => q.band === band);
    if (inBand.length === 0) continue;
    perBand.push({
      band,
      correct: inBand.filter(({ q, answer }) => answer === q.answer).length,
      total: inBand.length,
    });
  }

  // 低→高累计正确率:找到最高的"累计达标"档
  let estimated: LevelCode = LEVEL_CODES[0];
  let cumCorrect = 0;
  let cumTotal = 0;
  for (const b of perBand) {
    cumCorrect += b.correct;
    cumTotal += b.total;
    if (cumTotal > 0 && cumCorrect / cumTotal >= PLACEMENT_PASS_RATE) {
      estimated = b.band;
    }
  }

  return { perBand, estimated, totalCorrect, totalCount: usable.length };
}
