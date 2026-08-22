/**
 * @module OnboardingDialog
 * @description 新手引导对话框，提供 4 步向导帮助首次使用的用户配置 LLM API 并了解应用功能。
 *
 * 结构：本组件只负责步骤状态机与步骤指示器；各步骤 UI 拆分在
 * src/components/onboarding/ 子组件（StepWelcome / StepConfigureApi / StepPreview / StepFinish），
 * 连接测试逻辑封装在 use-connection-test hook。
 */

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { addModel } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { STEP_TITLES } from "./onboarding/constants";
import { StepConfigureApi } from "./onboarding/StepConfigureApi";
import { StepFinish } from "./onboarding/StepFinish";
import { StepPreview } from "./onboarding/StepPreview";
import { StepWelcome } from "./onboarding/StepWelcome";
import { useConnectionTest } from "./onboarding/use-connection-test";

/** OnboardingDialog 组件的 Props 接口 */
interface OnboardingDialogProps {
  /** 引导完成后的回调，通常用于关闭对话框并刷新页面状态 */
  onComplete: () => void;
}

/**
 * 新手引导对话框组件
 *
 * 4 步向导，帮助首次使用的用户配置 LLM API 并了解应用功能。
 * 使用 shadcn/ui Dialog 组件，内置 focus trap、Escape 处理、scroll lock。
 *
 * 步骤：
 * 1. 欢迎 — 应用介绍和功能概览
 * 2. 配置 API — 填写 API 地址、密钥、模型名，支持测试连接
 * 3. 体验预览 — 展示批改结果的静态示例
 * 4. 完成 — 配置总结和快速入口
 */
export function OnboardingDialog({ onComplete }: OnboardingDialogProps) {
  const [step, setStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("gpt-4o-mini");

  // 连接测试逻辑（use-connection-test hook）
  const { testing, testResult, testError, handleTestConnection, clearTestResult } =
    useConnectionTest({ baseUrl, apiKey, modelName });

  /** 第 3 步"开始使用"保存失败的错误信息（与第 1 步的 testError 分开，各自就近渲染） */
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  /** 保存模型配置并完成引导 */
  async function handleFinish() {
    setSaving(true);
    setSaveError("");
    try {
      await addModel({
        name: "默认模型",
        api_key: apiKey,
        base_url: baseUrl,
        model_name: modelName,
        is_default: true,
      });
      onComplete();
    } catch (err) {
      // 保存失败时停留在当前步骤并显示错误（saveError 在 step 3 渲染；
      // 此前误写入 testError——该 state 只在 step 1 渲染，用户看不到任何反馈）
      setSaveError(`模型配置保存失败：${getErrorMessage(err)}。可跳过后在设置中手动配置。`);
    } finally {
      setSaving(false);
    }
  }

  /** 字段变化时清除上次的测试结果（输入或应用预设后需重新测试） */
  function handleFieldChange(apply: () => void) {
    apply();
    clearTestResult();
  }

  /**
   * 处理 Dialog 的 open 状态变化。
   * 用户点击遮罩层或按 Escape 时 onOpenChange(false) 会被调用，
   * 我们忽略这个请求——用户必须通过向导按钮完成或跳过。
   */
  function handleOpenChange(open: boolean) {
    // 不允许通过 Escape 或遮罩层关闭，必须通过向导按钮完成
    if (!open) return;
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[560px] max-w-[calc(100%-2rem)] max-h-[90vh] flex flex-col overflow-hidden p-0"
      >
        {/* 无障碍标题（视觉隐藏） */}
        <DialogTitle className="sr-only">{STEP_TITLES[step]}</DialogTitle>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-0">
          {STEP_TITLES.map((title, i) => (
            <div key={title} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium transition-colors ${
                  i === step
                    ? "bg-primary text-primary-foreground"
                    : i < step
                      ? "bg-green-500 text-white"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span
                className={`text-xs ${
                  i === step ? "text-foreground font-medium" : "text-muted-foreground"
                }`}
              >
                {title}
              </span>
              {i < STEP_TITLES.length - 1 && (
                <div className={`w-8 h-px ${i < step ? "bg-green-500" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 0: Welcome */}
        {step === 0 && <StepWelcome onNext={() => setStep(1)} />}

        {/* Step 1: Configure API */}
        {step === 1 && (
          <StepConfigureApi
            baseUrl={baseUrl}
            apiKey={apiKey}
            modelName={modelName}
            onBaseUrlChange={setBaseUrl}
            onApiKeyChange={setApiKey}
            onModelNameChange={setModelName}
            testing={testing}
            testResult={testResult}
            testError={testError}
            onTestConnection={handleTestConnection}
            onFieldChange={handleFieldChange}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            onSkip={onComplete}
          />
        )}

        {/* Step 2: Try It Out (static preview) */}
        {step === 2 && <StepPreview onBack={() => setStep(1)} onNext={() => setStep(3)} />}

        {/* Step 3: All Set */}
        {step === 3 && <StepFinish saving={saving} saveError={saveError} onFinish={handleFinish} />}
      </DialogContent>
    </Dialog>
  );
}
