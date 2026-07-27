/**
 * 练习选项选择器 —— 难度 + 主题选择的共享 UI。
 *
 * R9: 消除 ListeningPage 和 SpeakingPage 中重复的难度/主题选择 UI。
 * 数据常量（DIFFICULTIES、TOPICS、isCustomTopic）已由 practice-options.ts 共享，
 * 本组件统一封装渲染逻辑。
 */

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DIFFICULTIES, isCustomTopic, TOPICS } from "@/lib/practice-options";

interface PracticeOptionsSelectorProps {
  difficulty: string;
  topic: string;
  onDifficultyChange: (difficulty: string) => void;
  onTopicChange: (topic: string) => void;
}

export function PracticeOptionsSelector({
  difficulty,
  topic,
  onDifficultyChange,
  onTopicChange,
}: PracticeOptionsSelectorProps) {
  const topicInputId = useId();
  return (
    <>
      <div className="space-y-2 w-full">
        <p className="text-sm font-medium">难度</p>
        <div className="flex gap-2">
          {DIFFICULTIES.map((d) => (
            <Button
              key={d}
              variant={difficulty === d ? "default" : "outline"}
              size="sm"
              onClick={() => onDifficultyChange(d)}
            >
              {d}
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
