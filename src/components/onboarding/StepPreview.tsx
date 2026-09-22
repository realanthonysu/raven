/**
 * @module onboarding/step-preview
 * @description 新手引导第 3 步：写作批改示例输出预览（静态数据）。
 */

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SAMPLE_RESULT } from "./constants";

interface StepPreviewProps {
  onBack: () => void;
  onNext: () => void;
}

export function StepPreview({ onBack, onNext }: StepPreviewProps) {
  return (
    <>
      <CardHeader>
        <CardTitle>体验预览</CardTitle>
        <p className="text-sm text-muted-foreground">
          以写作为例展示批改输出；听力/口语/阅读/复习同样在左侧导航一键进入
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 原文 */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            输入原文
          </span>
          <div className="p-3 rounded-md bg-muted/50 text-sm leading-relaxed">
            Yesterday I <span className="text-destructive line-through">go</span> to the library and
            borrowed two <span className="text-destructive line-through">book</span>. The librarian
            was very helpful, she <span className="text-destructive line-through">recommanded</span>{" "}
            me <span className="text-destructive line-through">a</span> interesting novel.
          </div>
        </div>

        {/* 纠错列表 */}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            纠错详情
          </span>
          {SAMPLE_RESULT.corrections.map((c) => (
            <div
              key={c.original}
              className="flex items-start gap-3 p-2.5 rounded-md border text-sm"
            >
              <Badge variant="secondary" className="shrink-0 mt-0.5">
                {c.category}
              </Badge>
              <div className="min-w-0">
                <span className="text-destructive line-through">{c.original}</span>
                {" -> "}
                <span className="text-green-600 dark:text-green-400 font-medium">
                  {c.corrected}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">{c.explanation}</p>
              </div>
            </div>
          ))}
        </div>

        {/* 总结 */}
        <div className="p-3 rounded-md bg-blue-500/5 border border-blue-500/20 text-sm">
          <span className="font-medium text-blue-600 dark:text-blue-400">总结：</span>
          {SAMPLE_RESULT.summary}
        </div>

        {/* 导航按钮 */}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            上一步
          </Button>
          <Button onClick={onNext}>
            下一步
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </>
  );
}
