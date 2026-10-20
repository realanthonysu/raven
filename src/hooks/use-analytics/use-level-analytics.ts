/**
 * Level estimation analytics sub-hook.
 *
 * 从编排层（useAnalytics）已解析并过滤好的各类型数据派生「分技能级别估计」
 * 与「升级建议」，供 LevelProgressCard 渲染雷达图与建议列表。
 *
 * 与其他子 hook 一致：解析已在编排层基于全部记录一次性完成，本 hook 直接
 * 消费已解析数组，经 buildSkillEstimates 归一化，不重复 JSON.parse。
 * 估计随当前全局级别（useProficiencyLevel）与时间范围（编排层 filtered
 * 后的 parsed 数组）变化而重算。
 */
import { useMemo } from "react";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import type { LevelUpSuggestion, SkillEstimate } from "@/lib/level-estimation";
import { buildSkillEstimates } from "@/lib/level-estimation-samples";
import type { HistoryRecord } from "@/types";
import type { ParsedExercise } from "./use-exercise-analytics";
import type { ParsedListening } from "./use-listening-analytics";
import type { ParsedSpeaking } from "./use-speaking-analytics";
import type { ParsedCorrection } from "./use-writing-analytics";

/** Return type for useLevelAnalytics. */
interface LevelAnalytics {
  /** 各技能级别估计（样本不足的技能不在其中） */
  levelEstimates: SkillEstimate[];
  /** 由当前级别 + 各技能估计生成的升级建议 */
  levelSuggestions: LevelUpSuggestion[];
}

/**
 * 计算分技能级别估计与升级建议。
 *
 * @param parsedCorrect  - 已解析的写作批改记录（correct/writing）
 * @param parsedExercise - 已解析的练习记录
 * @param parsedListening - 已解析的听力记录
 * @param parsedSpeaking - 已解析的口语记录
 * @param readingRecords - 阅读记录（仅元数据 difficulty_level，无 result）
 * @returns 各技能估计与升级建议
 */
export function useLevelAnalytics(
  parsedCorrect: ParsedCorrection[],
  parsedExercise: ParsedExercise[],
  parsedListening: ParsedListening[],
  parsedSpeaking: ParsedSpeaking[],
  readingRecords: HistoryRecord[],
): LevelAnalytics {
  const { level } = useProficiencyLevel();

  const { estimates, suggestions } = useMemo(
    () =>
      buildSkillEstimates(
        {
          correct: parsedCorrect,
          exercise: parsedExercise,
          listening: parsedListening,
          speaking: parsedSpeaking,
          reading: readingRecords,
        },
        level,
      ),
    [parsedCorrect, parsedExercise, parsedListening, parsedSpeaking, readingRecords, level],
  );

  return { levelEstimates: estimates, levelSuggestions: suggestions };
}
