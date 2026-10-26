/**
 * 英语水平级别体系 —— 全应用的"难度尺子"（单一事实来源）。
 *
 * 内部编码采用 CEFR 子集（A2–C1），显示层用中国考试锚点（中考/高考/四六级/
 * 专四专八）双标注：用户按自己认得的考试选级，prompt 与数据存储用 CEFR 码。
 * 考试与 CEFR 的对应是业界通行参照（四六级与 CSE/CEFR 无官方对接），
 * 界面文案一律用"≈"表述。
 *
 * 消费方：
 * - 5 个 LLM prompt 构建器经 levelPromptBlock() 注入难度规格（生成侧的"坡度"）
 * - practiceLevelOptions() 派生口语/听力练习的难度选择（替代原 初级/中级/高级）
 * - history.difficulty_level 列存储每次练习使用的级别码（测量侧的"标准"）
 * - settings 的 proficiency_level 键 + hooks/use-proficiency-level 全局 store
 */

/** CEFR 级别码 —— 有序，从低到高 */
export const LEVEL_CODES = ["A2", "B1", "B1+", "B2", "B2+", "C1"] as const;
export type LevelCode = (typeof LEVEL_CODES)[number];

/**
 * prompt 用的 CEFR 枚举文本 —— 从 LEVEL_CODES 派生。
 * 各 prompt 的 band 枚举指令一律引用此常量，禁止手写档位清单：
 * 尺子收缩（退役档位）时 prompt 随之更新，不会残留已退役档位。
 */
export const LEVEL_CODE_ENUM_TEXT = LEVEL_CODES.map((code) => `"${code}"`).join("、");

/** 默认级别 —— Onboarding 跳过/设置读取失败时的兜底 */
export const DEFAULT_LEVEL: LevelCode = "B1";

/** 单一级别的完整难度规格 */
export interface LevelSpec {
  code: LevelCode;
  /** 中国考试锚点（显示层双标注用） */
  anchor: string;
  /** 词汇范围描述（注入 prompt） */
  vocabBand: string;
  /** 单句长度规格（注入 prompt） */
  sentenceWords: string;
  /** 该级别应掌握的语法点（注入 prompt） */
  grammarFocus: string;
  /** 阅读/练习文本篇幅规格（注入 prompt） */
  passageWords: string;
}

/** 全部级别的规格表 —— 教学规格只在此维护，各 prompt 不各自定义难度 */
export const LEVEL_SPECS: Record<LevelCode, LevelSpec> = {
  A2: {
    code: "A2",
    anchor: "小学/初中 · 中考",
    vocabBand: "中考核心词汇（约 1600 词）以内",
    sentenceWords: "6–10 词",
    grammarFocus: "一般现在/过去时、简单并列句、基础疑问句、常见情态动词",
    passageWords: "80–150 词",
  },
  B1: {
    code: "B1",
    anchor: "高中 · 高考",
    vocabBand: "高考核心词汇（约 3500 词）以内",
    sentenceWords: "10–15 词",
    grammarFocus: "被动语态、定语从句、现在完成时、宾语从句、情态动词推测用法",
    passageWords: "150–300 词",
  },
  "B1+": {
    code: "B1+",
    anchor: "大学四级 CET-4",
    vocabBand: "大学英语四级词汇（约 4500 词）以内",
    sentenceWords: "12–18 词",
    grammarFocus: "非谓语动词（动名词/分词）、状语从句、初步虚拟语气、复杂宾补结构",
    passageWords: "250–400 词",
  },
  B2: {
    code: "B2",
    anchor: "大学六级 CET-6",
    vocabBand: "大学英语六级词汇（约 6000 词）以内",
    sentenceWords: "15–20 词",
    grammarFocus: "虚拟语气、倒装、独立主格、名词性从句嵌套",
    passageWords: "300–500 词",
  },
  "B2+": {
    code: "B2+",
    anchor: "专业四级 TEM-4",
    vocabBand: "英语专业四级词汇（约 8000 词）以内",
    sentenceWords: "18–25 词",
    grammarFocus: "复杂嵌套从句、名词化结构、强调与省略",
    passageWords: "400–600 词",
  },
  C1: {
    code: "C1",
    anchor: "专业八级 TEM-8 / 雅思 7+",
    vocabBand: "专业八级及以上词汇（约 13000 词），可含学术语域",
    sentenceWords: "20 词以上，可含复杂嵌套结构",
    grammarFocus: "任意复杂语法结构，学术与正式语域",
    passageWords: "500 词以上",
  },
};

/** 类型守卫：任意字符串是否为合法级别码（settings 读取时校验用） */
export function isLevelCode(v: unknown): v is LevelCode {
  return typeof v === "string" && (LEVEL_CODES as readonly string[]).includes(v);
}

/** 显示标签："B1+（≈大学四级 CET-4）" —— UI 徽章/选项通用 */
export function levelLabel(code: LevelCode): string {
  return `${code}（≈${LEVEL_SPECS[code].anchor}）`;
}

/**
 * 难度展示格式化 —— 持久化 difficulty 字符串的统一渲染入口。
 *
 * 新数据存 CEFR 级别码（如 "B2"），渲染为「码（≈考试锚点）」双标注标签；
 * 旧数据（初级/中级/高级 等非级别码字符串）原样返回，存量记录展示不变。
 * （自 practice-options 收编：这是 levels 域的显示函数，本就该与 levelLabel 同址。）
 *
 * @param v - 结果 JSON 中的 difficulty 原始字符串
 * @returns 可直接展示的难度文案
 */
export function formatDifficultyLabel(v: string): string {
  return isLevelCode(v) ? levelLabel(v) : v;
}

/** 自报定级选项 —— Onboarding/设置页用，用户按考试名选择，落库为 CEFR 码 */
export interface LevelSurveyOption {
  /** 用户可认得的考试/学段名称 */
  label: string;
  code: LevelCode;
}

export const LEVEL_SURVEY_OPTIONS: readonly LevelSurveyOption[] = [
  { label: "小学及以下", code: "A2" },
  { label: "初中（中考）", code: "A2" },
  { label: "高中（高考）", code: "B1" },
  { label: "大学四级", code: "B1+" },
  { label: "大学六级", code: "B2" },
  { label: "专业四级", code: "B2+" },
  { label: "专业八级 / 雅思·托福", code: "C1" },
];

/** 练习难度档（口语/听力选择器用）：基于当前级别的 低一档/标准/高一档 */
export interface PracticeLevelOption {
  code: LevelCode;
  /** 完整显示标签（含考试锚点） */
  label: string;
  /** 相对当前级别的关系提示 */
  hint: "低一档" | "标准" | "挑战";
}

/**
 * 由用户基准级别派生练习难度选项：[低一档, 标准, 高一档]，
 * 端点处收缩为 2 项（A2 没有 低一档，C1 没有 高一档）。
 * 返回顺序恒为从低到高，首个选项不作默认——调用方以"标准"档为默认。
 */
export function practiceLevelOptions(base: LevelCode): PracticeLevelOption[] {
  const idx = LEVEL_CODES.indexOf(base);
  const codes = LEVEL_CODES.slice(Math.max(0, idx - 1), idx + 2);
  return codes.map((code) => {
    const delta = LEVEL_CODES.indexOf(code) - idx;
    const hint = delta < 0 ? "低一档" : delta > 0 ? "挑战" : "标准";
    return { code, label: levelLabel(code), hint };
  });
}

/** 技能维度 —— levelPromptBlock 的消费者枚举（与 5 个 LLM 页面一一对应） */
export type LevelSkill = "writing" | "reading" | "speaking" | "listening" | "exercise";

/** 各技能的附加难度指令 —— 教学语义只在此维护 */
const SKILL_DIRECTIVES: Record<LevelSkill, string> = {
  writing:
    "纠错与建议以此级别为基准：重点标注该级别应掌握而未掌握的错误；明显超出该级别的表达不当可顺带指出，但不计为错误。",
  reading:
    "讲解深度适配该级别读者：重点词汇的生僻度不超过该级别以上一级；长难句拆解与语法点优先选取该级别应掌握的典型结构。",
  speaking: "生成句子严格落在上述词汇与句长规格内，5 句按难度从下限到上限递进。",
  listening: "生成句子严格落在上述词汇与句长规格内，5 句按难度递进；中文提示保持简短。",
  exercise: "题干词汇与句子复杂度严格按该级别标准命制，考点限于该级别应掌握的语法点。",
};

/**
 * 构建注入 LLM prompt 的难度规格块。
 * 返回以【难度规格】开头的多行中文块，prompt 构建器直接拼接到系统提示中。
 */
export function levelPromptBlock(level: LevelCode, skill: LevelSkill): string {
  const spec = LEVEL_SPECS[level];
  return [
    `【难度规格 · CEFR ${spec.code}，≈${spec.anchor}】`,
    `- 词汇范围：${spec.vocabBand}`,
    `- 句子复杂度：单句 ${spec.sentenceWords}；语法范围：${spec.grammarFocus}`,
    `- 篇幅：${spec.passageWords}`,
    `- ${SKILL_DIRECTIVES[skill]}`,
  ].join("\n");
}
