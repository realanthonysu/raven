/**
 * @module onboarding/step-configure-api
 * @description 新手引导第 2 步：配置 API（地址/密钥/模型名 + 测试连接）。
 */

import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isLocalBaseUrl } from "@/services/llm";
import { API_PRESETS } from "./constants";
import type { TestResult } from "./use-connection-test";

interface StepConfigureApiProps {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  onBaseUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onModelNameChange: (v: string) => void;
  testing: boolean;
  testResult: TestResult | null;
  testError: string;
  onTestConnection: () => void;
  /** 输入变化后清除上次的测试结果 */
  onFieldChange: (apply: () => void) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function StepConfigureApi({
  baseUrl,
  apiKey,
  modelName,
  onBaseUrlChange,
  onApiKeyChange,
  onModelNameChange,
  testing,
  testResult,
  testError,
  onTestConnection,
  onFieldChange,
  onBack,
  onNext,
  onSkip,
}: StepConfigureApiProps) {
  const [showPresets, setShowPresets] = useState(false);

  /** 应用预设配置 */
  function applyPreset(preset: (typeof API_PRESETS)[number]) {
    onFieldChange(() => {
      onBaseUrlChange(preset.baseUrl);
      onModelNameChange(preset.model);
    });
    setShowPresets(false);
  }

  function canProceedFromStep2() {
    return testResult === "success";
  }

  return (
    <>
      <CardHeader>
        <CardTitle>配置 API</CardTitle>
        <p className="text-sm text-muted-foreground">
          Raven 完全基于 MiMo 模型生态，推荐使用 MiMo；也兼容 OpenAI、DeepSeek 等接口
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* API 地址 + 预设下拉 */}
        <div className="space-y-1.5">
          <label htmlFor="onboarding-base-url" className="text-sm font-medium">
            API 地址
          </label>
          <div className="relative">
            <Input
              id="onboarding-base-url"
              value={baseUrl}
              onChange={(e) => onFieldChange(() => onBaseUrlChange(e.target.value))}
              placeholder="https://api.xiaomimimo.com/v1"
            />
            <button
              type="button"
              onClick={() => setShowPresets(!showPresets)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            {showPresets && (
              <div className="absolute right-0 top-full mt-1 z-10 bg-popover border rounded-md shadow-md p-1 min-w-[180px]">
                {API_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.label}
                    onClick={() => applyPreset(preset)}
                    className="w-full text-left px-3 py-1.5 text-sm rounded-sm hover:bg-accent"
                  >
                    {preset.label}
                    {"hint" in preset && preset.hint && (
                      <span className="ml-1.5 text-xs text-muted-foreground">{preset.hint}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            MiMo 控制台（platform.xiaomimimo.com）获取 API Key；也支持 Ollama
            (http://localhost:11434/v1)
          </p>
        </div>

        {/* API 密钥 */}
        <div className="space-y-1.5">
          <label htmlFor="onboarding-api-key" className="text-sm font-medium">
            API 密钥
          </label>
          <Input
            id="onboarding-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => onFieldChange(() => onApiKeyChange(e.target.value))}
            placeholder="sk-..."
          />
          <p className="text-xs text-muted-foreground">
            MiMo 用户在 <span className="font-medium">platform.xiaomimimo.com → API Key</span>{" "}
            创建并复制
          </p>
        </div>

        {/* 模型名称 */}
        <div className="space-y-1.5">
          <label htmlFor="onboarding-model-name" className="text-sm font-medium">
            模型名称
          </label>
          <Input
            id="onboarding-model-name"
            value={modelName}
            onChange={(e) => onFieldChange(() => onModelNameChange(e.target.value))}
            placeholder="mimo-v2.5"
          />
          <p className="text-xs text-muted-foreground">
            MiMo 推荐 mimo-v2.5（或 mimo-v2.5-pro）；DeepSeek 填 deepseek-chat
          </p>
        </div>

        {/* 测试连接 */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={onTestConnection}
            disabled={testing || !baseUrl || !modelName || (!apiKey && !isLocalBaseUrl(baseUrl))}
          >
            {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            测试连接
          </Button>
          {testResult === "success" && (
            <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              连接成功
            </span>
          )}
          {testResult === "error" && (
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <XCircle className="h-4 w-4" />
              {testError || "连接失败"}
            </span>
          )}
        </div>

        {/* 导航按钮 */}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            上一步
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              跳过
            </Button>
            <Button onClick={onNext} disabled={!canProceedFromStep2()}>
              下一步
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </CardContent>
    </>
  );
}
