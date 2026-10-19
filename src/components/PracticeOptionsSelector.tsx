/**
 * 练习选项选择器 —— 难度 + 主题选择的共享 UI。
 *
 * R9: 消除 ListeningPage 和 SpeakingPage 中重复的难度/主题选择 UI。
 * 主题数据常量（TOPICS、isCustomTopic）由 practice-options.ts 共享；
 * 难度选项为 PracticeLevelOption[]（页面经 practiceLevelOptions 基于用户
 * 基准级别派生），本组件只负责渲染「码（≈考试锚点）」标签 + 低一档/标准/挑战
 * 关系徽章，选中值为 LevelCode。
 */

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LevelCode, PracticeLevelOption } from "@/lib/practice-options";
import { isCustomTopic, TOPICS } from "@/lib/practice-options";

interface PracticeOptionsSelectorProps {
  /** 当前选中的级别码（页面以有效难度 effectiveLevel 传入） */
  level: LevelCode;
  /** 难度选项（由基准级别派生，恒从低到高，端点处收缩为 2 项） */
  levelOptions: PracticeLevelOption[];
  topic: string;
  onLevelChange: (level: LevelCode) => void;
  onTopicChange: (topic: string) => void;
}

export function PracticeOptionsSelector({
  level,
  levelOptions,
  topic,
  onLevelChange,
  onTopicChange,
}: PracticeOptionsSelectorProps) {
  const topicInputId = useId();
  return (
    <>
      <div className="space-y-2 w-full">
        <p className="text-sm font-medium">难度</p>
        <div className="flex gap-2 flex-wrap">
          {levelOptions.map((opt) => (
            <Button
              key={opt.code}
              variant={level === opt.code ? "default" : "outline"}
              size="sm"
              onClick={() => onLevelChange(opt.code)}
              className="gap-1.5"
            >
              {opt.label}
              {/* 关系徽章：与基准级的关系（低一档/标准/挑战），
                  半透明底在 default/outline 两种变体下均可用 */}
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                {opt.hint}
              </span>
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2 w-full">
        <label htmlFor={topicInputId} className="text-sm font-medium">
          主题
        </label>
        <div className="flex gap-2 flex-wrap">
          {TOPICS.map((t) => (
            <Button
              key={t}
              variant={topic === t ? "default" : "outline"}
              size="sm"
              onClick={() => onTopicChange(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <Input
          id={topicInputId}
          className="mt-1"
          placeholder="或输入自定义主题..."
          value={isCustomTopic(topic) ? topic : ""}
          onChange={(e) => onTopicChange(e.target.value)}
        />
      </div>
    </>
  );
}
