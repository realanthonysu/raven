/** 学习目标卡片 —— 每日学习目标设置（复习/练习/阅读/写作/听力），支持预设方案。 */

import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLearningGoals, setLearningGoal } from "@/lib/db";

/** 学习目标标签（长版，适配 Settings 详细说明）。Sidebar 使用短版标签。 */
const GOAL_LABELS: Record<string, string> = {
  review: "间隔复习",
  exercise: "弱项训练",
  reading: "阅读精读",
  writing: "写作批改",
  listening: "听力练习",
};

/** 预设目标配置 */
const GOAL_PRESETS: Record<string, Record<string, number>> = {
  轻松: { review: 5, exercise: 1, reading: 1, writing: 1, listening: 1 },
  标准: { review: 10, exercise: 2, reading: 1, writing: 1, listening: 1 },
  进阶: { review: 20, exercise: 3, reading: 2, writing: 2, listening: 2 },
};

interface GoalCardProps {
  onError: (msg: string) => void;
}

export function GoalCard({ onError }: GoalCardProps) {
  const [goals, setGoals] = useState<Record<string, number>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});

  useEffect(() => {
    getLearningGoals()
      .then(setGoals)
      .catch((err) => console.warn("load goals failed", err));
  }, []);

  function handleEdit() {
    setDraft({ ...goals });
    setIsEditing(true);
  }

  function handleUpdateDraft(goalType: string, target: number) {
    const clamped = Math.max(0, target);
    setDraft((prev) => ({ ...prev, [goalType]: clamped }));
  }

  async function handleSave() {
    const prev = goals;
    setGoals(draft);
    try {
      const results = await Promise.allSettled(
        Object.entries(draft).map(([type, target]) => setLearningGoal(type, target)),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.warn("handleSaveGoals: some goals failed to save", failed);
        onError(`部分学习目标保存失败（${failed.length} 项），请重试`);
        getLearningGoals()
          .then(setGoals)
          .catch(() => {});
      } else {
        window.dispatchEvent(new CustomEvent("learning-goals-changed"));
        setIsEditing(false);
      }
    } catch (err) {
      setGoals(prev);
      onError(`保存学习目标失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  function handleCancel() {
    setIsEditing(false);
    setDraft({});
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>学习目标</CardTitle>
        <CardAction>
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                取消
              </Button>
              <Button size="sm" onClick={handleSave}>
                保存
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={handleEdit}>
              编辑
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {isEditing && (
          <div className="flex gap-2 flex-wrap">
            {Object.entries(GOAL_PRESETS).map(([name, preset]) => (
              <Button
                key={name}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setDraft(preset)}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {Object.entries(GOAL_LABELS).map(([type, label]) => {
            const current = isEditing ? (draft[type] ?? 0) : (goals[type] ?? 0);
            return (
              <div key={type} className="flex items-center justify-between">
                <span className="text-sm">{label}</span>
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleUpdateDraft(type, current - 1)}
                      disabled={current <= 0}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-8 text-center text-sm font-medium tabular-nums">
                      {current}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleUpdateDraft(type, current + 1)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <span className="text-sm font-medium tabular-nums">{current}</span>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
