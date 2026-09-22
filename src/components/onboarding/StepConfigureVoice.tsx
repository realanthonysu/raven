/**
 * @module onboarding/step-configure-voice
 * @description 新手引导语音步骤：配置 TTS/ASR（听/说能力），默认推荐 MiMo 语音。
 *
 * 与文本模型共用 base_url 与 API Key（MiMo 全栈同一平台），避免用户二次填密钥。
 */

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { VOICE_PRESETS } from "./constants";

export interface VoiceFormState {
  ttsModel: string;
  ttsVoice: string;
  asrModel: string;
  /** 是否复用文本模型的 base_url + api_key（MiMo 全栈推荐） */
  reuseTextCredentials: boolean;
  baseUrl: string;
  apiKey: string;
  /** 保存后是否测试过（可跳过） */
  configured: boolean;
}

interface StepConfigureVoiceProps {
  voice: VoiceFormState;
  onVoiceChange: (patch: Partial<VoiceFormState>) => void;
  saving: boolean;
  saveError: string;
  onSave: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function StepConfigureVoice({
  voice,
  onVoiceChange,
  saving,
  saveError,
  onSave,
  onBack,
  onNext,
  onSkip,
}: StepConfigureVoiceProps) {
  const canProceed = voice.configured || true; // 允许跳过语音，后续可在设置中配置

  async function handleSaveAndNext() {
    await onSave();
    onNext();
  }

  return (
    <>
      <CardHeader>
        <CardTitle>配置语音</CardTitle>
        <p className="text-sm text-muted-foreground">
          听力训练与口语跟读依赖 TTS/ASR。MiMo 语音与文本模型共用同一 API Key。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 语音预设 */}
        <div className="space-y-1.5">
          <span className="text-sm font-medium">语音预设</span>
          <div className="flex flex-wrap gap-2">
            {VOICE_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={
                  voice.ttsModel === preset.ttsModel && voice.asrModel === preset.asrModel
                    ? "default"
                    : "outline"
                }
                onClick={() =>
                  onVoiceChange({
                    ttsModel: preset.ttsModel,
                    ttsVoice: preset.ttsVoice,
                    asrModel: preset.asrModel,
                    configured: false,
                  })
                }
              >
                {preset.label}
                <span className="ml-1.5 text-xs opacity-70">{preset.hint}</span>
              </Button>
            ))}
          </div>
        </div>

        {/* 凭据来源 */}
        <div className="flex items-center gap-2">
          <input
            id="onboarding-voice-reuse"
            type="checkbox"
            checked={voice.reuseTextCredentials}
            onChange={(e) =>
              onVoiceChange({
                reuseTextCredentials: e.target.checked,
                configured: false,
                ...(e.target.checked ? {} : { baseUrl: "", apiKey: "" }),
              })
            }
            className="h-4 w-4"
          />
          <label htmlFor="onboarding-voice-reuse" className="text-sm">
            与文本模型共用 API 地址与密钥（推荐）
          </label>
        </div>

        {!voice.reuseTextCredentials && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="onboarding-voice-base-url" className="text-sm font-medium">
                语音 API 地址
              </label>
              <Input
                id="onboarding-voice-base-url"
                value={voice.baseUrl}
                onChange={(e) => onVoiceChange({ baseUrl: e.target.value, configured: false })}
                placeholder="https://api.xiaomimimo.com/v1"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="onboarding-voice-api-key" className="text-sm font-medium">
                语音 API 密钥
              </label>
              <Input
                id="onboarding-voice-api-key"
                type="password"
                value={voice.apiKey}
                onChange={(e) => onVoiceChange({ apiKey: e.target.value, configured: false })}
                placeholder="sk-..."
              />
            </div>
          </div>
        )}

        {/* TTS 模型 / 音色 / ASR 模型 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="onboarding-tts-model" className="text-sm font-medium">
              TTS 模型
            </label>
            <Input
              id="onboarding-tts-model"
              value={voice.ttsModel}
              onChange={(e) => onVoiceChange({ ttsModel: e.target.value, configured: false })}
              placeholder="mimo-v2.5-tts"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="onboarding-tts-voice" className="text-sm font-medium">
              音色
            </label>
            <Input
              id="onboarding-tts-voice"
              value={voice.ttsVoice}
              onChange={(e) => onVoiceChange({ ttsVoice: e.target.value, configured: false })}
              placeholder="冰糖"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="onboarding-asr-model" className="text-sm font-medium">
              ASR 模型
            </label>
            <Input
              id="onboarding-asr-model"
              value={voice.asrModel}
              onChange={(e) => onVoiceChange({ asrModel: e.target.value, configured: false })}
              placeholder="mimo-v2.5-asr"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          MiMo 音色示例：冰糖 / 茉莉 / 苏打 / 白桦。完整列表见设置 → 语音。
        </p>

        {/* 保存状态 */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={onSave}
            disabled={saving || !voice.ttsModel || !voice.asrModel}
          >
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            保存语音配置
          </Button>
          {voice.configured && (
            <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              已保存
            </span>
          )}
          {saveError && (
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <XCircle className="h-4 w-4" />
              {saveError}
            </span>
          )}
        </div>

        {/* 导航 */}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            上一步
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              跳过语音
            </Button>
            <Button onClick={handleSaveAndNext} disabled={!canProceed}>
              下一步
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </CardContent>
    </>
  );
}
