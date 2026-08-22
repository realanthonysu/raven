/**
 * @module onboarding/step-welcome
 * @description 新手引导第 1 步：欢迎与功能概览。
 */

import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FEATURES } from "./constants";

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl">欢迎使用 Raven</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">AI 驱动的英语学习助手</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {FEATURES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
              <Icon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={onNext}>
            开始配置
            <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </>
  );
}
