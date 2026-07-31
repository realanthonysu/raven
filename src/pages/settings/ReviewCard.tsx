/** 复习设置卡片 —— FSRS 目标留存率配置（影响复习间隔的紧凑程度）。 */

import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSetting, setSetting } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";

/** 默认目标留存率（与 Rust 端 FSRS_DEFAULT_REQUEST_RETENTION 保持一致）。 */
const DEFAULT_RETENTION = "0.9";

/** 预设方案：值与 Rust 端 clamp 范围 [0.7, 0.97] 兼容。 */
const RETENTION_PRESETS = [
  {
    value: "0.8",
    label: "轻松",
    description: "间隔更长、复习量更少，适合休闲学习",
  },
  {
    value: "0.9",
    label: "标准（推荐）",
    description: "FSRS 默认目标，复习量与记忆效果均衡",
  },
  {
    value: "0.95",
    label: "强化",
    description: "间隔更短、记得更牢，适合备考冲刺",
  },
] as const;

interface ReviewCardProps {
  onError: (msg: string) => void;
}

/**
 * 复习设置卡片。
 *
 * 管理 settings 表的 `fsrs_request_retention` 键：目标留存率越高，
 * FSRS 安排的复习间隔越短（复习越频繁），记忆保持越牢固。
 */
export function ReviewCard({ onError }: ReviewCardProps) {
  const [retention, setRetention] = useState(DEFAULT_RETENTION);

  useEffect(() => {
    getSetting("fsrs_request_retention")
      .then((val) => {
        if (val && !Number.isNaN(Number.parseFloat(val))) setRetention(val);
      })
      .catch((err) => console.warn("load fsrs_request_retention failed", err));
  }, []);

  async function handleSelect(value: string) {
    if (value === retention) return;
    const prev = retention;
    setRetention(value);
    try {
      await setSetting("fsrs_request_retention", value);
    } catch (err) {
      setRetention(prev);
      onError(`更新复习设置失败：${getErrorMessage(err)}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>复习设置</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Target className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="font-medium">目标留存率</p>
            <p className="text-sm text-muted-foreground">
              控制复习频率：留存率越高，复习间隔越短、记忆越牢固
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {RETENTION_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              variant={retention === preset.value ? "default" : "outline"}
              className="h-auto flex-col items-start gap-1 px-3 py-2 text-left"
              onClick={() => handleSelect(preset.value)}
            >
              <span className="text-sm font-medium">{preset.label}</span>
              <span className="text-xs font-normal opacity-80">
                {Math.round(Number.parseFloat(preset.value) * 100)}%
              </span>
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {RETENTION_PRESETS.find((p) => p.value === retention)?.description ??
            `当前使用自定义留存率 ${retention}`}
        </p>
      </CardContent>
    </Card>
  );
}
