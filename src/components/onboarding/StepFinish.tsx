/**
 * @module onboarding/step-finish
 * @description 新手引导第 4 步：配置完成与快速入口。
 */

import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QUICK_START_ENTRIES } from "./constants";

interface StepFinishProps {
  saving: boolean;
  saveError: string;
  onFinish: () => void;
}

export function StepFinish({ saving, saveError, onFinish }: StepFinishProps) {
  return (
    <>
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-green-500/10">
          <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
        <CardTitle className="text-xl">配置完成</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">你已准备好开始学习</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {QUICK_START_ENTRIES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex items-center gap-3 p-2.5 rounded-lg border">
              <Icon className="h-4 w-4 text-primary shrink-0" />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={onFinish} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            开始使用
          </Button>
        </div>
        {saveError && (
          <p className="text-sm text-destructive" role="alert">
            {saveError}
          </p>
        )}
      </CardContent>
    </>
  );
}
