/**
 * useEffectivePracticeLevel —— 练习页（听力/口语）的难度级别派生与定格。
 *
 * 此前 ListeningPage 与 SpeakingPage 逐字复制同一段逻辑：
 * 由用户基准级别（useProficiencyLevel）派生「低一档/标准/挑战」三档、
 * 用户未手动选择前跟随「标准」档、水合后原选择出列表时回落「标准」档，
 * 并在生成发起时把有效级别定格到 ref 供落库/展示共用。
 *
 * 本 hook 收敛该逻辑（与 usePracticeSession 同一思路：收敛页面样板，
 * 页面只消费结果）。定格语义仍由页面掌握 —— hook 只负责在初次渲染时用
 * effectiveLevel 初始化 ref（此后不随渲染自动更新），页面在生成发起时
 * 显式写入 `effectiveLevelRef.current = effectiveLevel`。
 */
import { useMemo, useRef, useState } from "react";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { type LevelCode, type PracticeLevelOption, practiceLevelOptions } from "@/lib/levels";

export function useEffectivePracticeLevel(): {
  levelOptions: PracticeLevelOption[];
  effectiveLevel: LevelCode;
  effectiveLevelRef: React.RefObject<LevelCode>;
  selectLevel: (level: LevelCode) => void;
} {
  const { level: baseLevel } = useProficiencyLevel();
  const levelOptions = useMemo(() => practiceLevelOptions(baseLevel), [baseLevel]);
  const standardLevel = levelOptions.find((o) => o.hint === "标准")?.code ?? baseLevel;
  const [selectedLevel, setSelectedLevel] = useState<LevelCode | null>(null);
  const effectiveLevel =
    selectedLevel && levelOptions.some((o) => o.code === selectedLevel)
      ? selectedLevel
      : standardLevel;
  const effectiveLevelRef = useRef<LevelCode>(effectiveLevel);
  return { levelOptions, effectiveLevel, effectiveLevelRef, selectLevel: setSelectedLevel };
}
