/**
 * @module onboarding/step-select-level
 * @description 新手引导第 3 步：自报英语水平定级（CEFR 级别 + 考试锚点双标注）。
 *
 * 用户按自己认得的考试/学段选择，落库为 CEFR 码（见 lib/levels.ts 的
 * LEVEL_SURVEY_OPTIONS）。选中即经全局 store 持久化（setLevelGlobal，
 * write-through），之后阅读/练习等内容按该级别生成。
 */

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { LEVEL_SURVEY_OPTIONS, levelLabel } from "@/lib/levels";

interface StepSelectLevelProps {
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function StepSelectLevel({ onBack, onNext, onSkip }: StepSelectLevelProps) {
  // setLevel 即 setLevelGlobal：先更新内存快照（UI 即时响应）再异步落库
  const { level, setLevel } = useProficiencyLevel();

  return (
    <>
      <CardHeader>
        <CardTitle>选择英语水平</CardTitle>
        <p className="text-sm text-muted-foreground">
          按你最熟悉的考试或学段选择。Raven 采用 CEFR 国际级别（A2–C1），
          阅读精读、弱项训练等内容会按当前级别调整难度。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 级别单选列表：主行考试/学段名，副行对应 CEFR 级别与锚点 */}
        <div className="space-y-1.5">
          {LEVEL_SURVEY_OPTIONS.map((option) => {
            const selected = level === option.code;
            return (
              <label
                key={option.label}
                className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                  selected ? "border-primary bg-primary/5" : "hover:bg-accent"
                }`}
              >
                <input
                  type="radio"
                  name="onboarding-level"
                  value={option.code}
                  checked={selected}
                  onChange={() => setLevel(option.code)}
                  className="h-4 w-4 shrink-0"
                />
                <span className="font-medium">{option.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {levelLabel(option.code)}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          当前选择：{levelLabel(level)}。之后可随时在「设置 → 英语水平定级」中修改。
        </p>

        {/* 导航：跳过沿用现有步骤机制（跳到下一步，不中断引导） */}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            上一步
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              跳过
            </Button>
            <Button onClick={onNext}>
              下一步
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </CardContent>
    </>
  );
}
