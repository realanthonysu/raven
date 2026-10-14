/**
 * @module OnboardingDialog
 * @description 新手引导对话框，提供 5 步向导帮助首次使用的用户配置 MiMo 模型生态
 * （文本 LLM + TTS/ASR）并了解应用功能。
 *
 * 结构：本组件只负责步骤状态机与步骤指示器；各步骤 UI 拆分在
 * src/components/onboarding/ 子组件，连接测试逻辑封装在 use-connection-test hook。
 */

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { addModel, setASRModel } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { saveTTSSettings } from "@/services/tts";
import { API_PRESETS, MIMO_VOICE_DEFAULTS, STEP_TITLES } from "./onboarding/constants";
import { StepConfigureApi } from "./onboarding/StepConfigureApi";
import { StepConfigureVoice, type VoiceFormState } from "./onboarding/StepConfigureVoice";
import { StepFinish } from "./onboarding/StepFinish";
import { StepPreview } from "./onboarding/StepPreview";
import { StepWelcome } from "./onboarding/StepWelcome";
import { useConnectionTest } from "./onboarding/use-connection-test";

const MIMO_PRESET = API_PRESETS[0];

/** OnboardingDialog 组件的 Props 接口 */
interface OnboardingDialogProps {
  /** 引导完成后的回调，通常用于关闭对话框并刷新页面状态 */
  onComplete: () => void;
}

/**
 * 新手引导对话框组件
 *
 * 5 步向导：欢迎 → 配置文本 API（默认 MiMo）→ 配置语音（TTS/ASR）→ 体验预览 → 完成。
 * 使用 shadcn/ui Dialog 组件，内置 focus trap、Escape 处理、scroll lock。
 */
export function OnboardingDialog({ onComplete }: OnboardingDialogProps) {
  const [step, setStep] = useState(0);
  // 默认 MiMo 预设——本应用完全基于 MiMo 模型生态
  // useState 显式标注 string：API_PRESETS 为 as const，字面量类型会收窄 setter 签名
  const [baseUrl, setBaseUrl] = useState<string>(MIMO_PRESET.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState<string>(MIMO_PRESET.model);

  const [voice, setVoice] = useState<VoiceFormState>({
    ttsModel: MIMO_VOICE_DEFAULTS.ttsModel,
    ttsVoice: MIMO_VOICE_DEFAULTS.ttsVoice,
    asrModel: MIMO_VOICE_DEFAULTS.asrModel,
    reuseTextCredentials: true,
    baseUrl: "",
    apiKey: "",
    configured: false,
  });
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceSaveError, setVoiceSaveError] = useState("");

  // 连接测试逻辑（use-connection-test hook）
  const { testing, testResult, testError, handleTestConnection, clearTestResult } =
    useConnectionTest({ baseUrl, apiKey, modelName });

  /** 第 4 步"开始使用"保存失败的错误信息 */
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  /** 保存语音配置（TTS/ASR）；返回是否成功，失败时引导不推进 */
  async function handleSaveVoice(): Promise<boolean> {
    setVoiceSaving(true);
    setVoiceSaveError("");
    try {
      const effectiveBaseUrl = voice.reuseTextCredentials ? baseUrl : voice.baseUrl;
      const effectiveApiKey = voice.reuseTextCredentials ? apiKey : voice.apiKey;
      const entries: Array<[string, string]> = [
        ["tts_base_url", effectiveBaseUrl],
        ["tts_model", voice.ttsModel],
        ["tts_voice", voice.ttsVoice],
        ["tts_speed", "1.0"],
        ["tts_dialect", "mimo"],
      ];
      if (effectiveApiKey) {
        entries.push(["tts_api_key", effectiveApiKey]);
      }
      await Promise.all([saveTTSSettings(entries), setASRModel(voice.asrModel)]);
      setVoice((v) => ({ ...v, configured: true }));
      return true;
    } catch (err) {
      setVoiceSaveError(
        `语音配置保存失败：${getErrorMessage(err)}。可修正后重试，或跳过语音稍后在设置中配置。`,
      );
      return false;
    } finally {
      setVoiceSaving(false);
    }
  }

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
      setSaveError(`模型配置保存失败：${getErrorMessage(err)}。可跳过后在设置中手动配置。`);
    } finally {
      setSaving(false);
    }
  }

  /** 字段变化时清除上次的测试结果 */
  function handleFieldChange(apply: () => void) {
    apply();
    clearTestResult();
  }

  /** 不允许通过 Escape 或遮罩层关闭，必须通过向导按钮完成 */
  function handleOpenChange(open: boolean) {
    if (!open) return;
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[560px] max-w-[calc(100%-2rem)] max-h-[90vh] flex flex-col overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{STEP_TITLES[step]}</DialogTitle>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-0 flex-wrap">
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
                <div className={`w-6 h-px ${i < step ? "bg-green-500" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 0: Welcome */}
        {step === 0 && <StepWelcome onNext={() => setStep(1)} />}

        {/* Step 1: Configure LLM API */}
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

        {/* Step 2: Configure voice (TTS/ASR) */}
        {step === 2 && (
          <StepConfigureVoice
            voice={voice}
            onVoiceChange={(patch) => setVoice((v) => ({ ...v, ...patch }))}
            saving={voiceSaving}
            saveError={voiceSaveError}
            onSave={handleSaveVoice}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            onSkip={() => setStep(3)}
          />
        )}

        {/* Step 3: Try It Out (static preview) */}
        {step === 3 && <StepPreview onBack={() => setStep(2)} onNext={() => setStep(4)} />}

        {/* Step 4: All Set */}
        {step === 4 && <StepFinish saving={saving} saveError={saveError} onFinish={handleFinish} />}
      </DialogContent>
    </Dialog>
  );
}
