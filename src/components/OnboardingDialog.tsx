/**
 * @module OnboardingDialog
 * @description 新手引导对话框模块，提供 4 步向导帮助首次使用的用户配置 LLM API 并了解应用功能。
 */

import {
  ArrowLeft,
  ArrowRight,
  BookCheck,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Sparkles,
  Target,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addModel } from "@/lib/db";
import { smartFetch } from "@/lib/fetch-utils";

/** OnboardingDialog 组件的 Props 接口 */
interface OnboardingDialogProps {
  /** 引导完成后的回调，通常用于关闭对话框并刷新页面状态 */
  onComplete: () => void;
}

const FEATURES = [
  { icon: BookCheck, label: "写作批改", desc: "AI 智能纠错，分类解析错误" },
  { icon: BookOpen, label: "阅读精读", desc: "六维深度分析，知识图谱" },
  { icon: Brain, label: "间隔复习", desc: "科学记忆曲线，高效背词" },
  { icon: Target, label: "弱项训练", desc: "针对薄弱点，专项突破" },
];

const API_PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
];

const SAMPLE_RESULT = {
  corrected_text:
    "Yesterday I went to the library and borrowed two books. The librarian was very helpful; she recommended an interesting novel to me.",
  corrections: [
    {
      original: "go",
      corrected: "went",
      category: "时态",
      explanation: '"Yesterday" 表示过去时间，动词需用过去式 went。',
    },
    {
      original: "two book",
      corrected: "two books",
      category: "单复数",
      explanation: '"two" 后接可数名词复数形式 books。',
    },
    {
      original: "recommanded",
      corrected: "recommended",
      category: "拼写",
      explanation: "recommended 拼写为两个 m。",
    },
    {
      original: "a interesting",
      corrected: "an interesting",
      category: "冠词",
      explanation: '"interesting" 以元音音素开头，冠词用 an。',
    },
  ],
  summary: "文章涉及 4 类常见错误：时态、单复数、拼写和冠词。整体表达基本通顺，注意细节即可。",
};

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
  const [showPresets, setShowPresets] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);

  /** 测试 API 连接：发送一条简单的 chat completion 请求 */
  async function handleTestConnection() {
    if (!apiKey || !baseUrl || !modelName) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");

    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await smartFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      // Validate response body is a valid chat completion
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.choices)) {
        throw new Error("API 返回了非预期的响应格式，请检查模型名称是否正确。");
      }

      setTestResult("success");
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : "连接失败");
    } finally {
      setTesting(false);
    }
  }

  /** 保存模型配置并完成引导 */
  async function handleFinish() {
    setSaving(true);
    try {
      await addModel({
        name: "默认模型",
        api_key: apiKey,
        base_url: baseUrl,
        model_name: modelName,
        is_default: true,
      });
    } catch {
      // 即使保存失败也关闭引导，用户可稍后在设置中手动配置
    } finally {
      setSaving(false);
      onComplete();
    }
  }

  /** 应用预设配置 */
  function applyPreset(preset: (typeof API_PRESETS)[number]) {
    setBaseUrl(preset.baseUrl);
    setModelName(preset.model);
    setShowPresets(false);
    setTestResult(null);
  }

  function canProceedFromStep2() {
    return testResult === "success";
  }

  const stepTitles = ["欢迎", "配置 API", "体验预览", "完成"];

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
        <DialogTitle className="sr-only">{stepTitles[step]}</DialogTitle>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-0">
          {stepTitles.map((title, i) => (
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
              {i < stepTitles.length - 1 && (
                <div className={`w-8 h-px ${i < step ? "bg-green-500" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 0: Welcome */}
        {step === 0 && (
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
                <Button onClick={() => setStep(1)}>
                  开始配置
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </>
        )}

        {/* Step 1: Configure API */}
        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle>配置 API</CardTitle>
              <p className="text-sm text-muted-foreground">
                Raven 需要一个 OpenAI 兼容的 API 来提供 AI 能力
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
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder="https://api.openai.com/v1"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPresets(!showPresets)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  {showPresets && (
                    <div className="absolute right-0 top-full mt-1 z-10 bg-popover border rounded-md shadow-md p-1 min-w-[140px]">
                      {API_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.label}
                          onClick={() => applyPreset(preset)}
                          className="w-full text-left px-3 py-1.5 text-sm rounded-sm hover:bg-accent"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  支持 OpenAI、DeepSeek 等兼容接口，也可使用 Ollama (http://localhost:11434/v1)
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
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="sk-..."
                />
              </div>

              {/* 模型名称 */}
              <div className="space-y-1.5">
                <label htmlFor="onboarding-model-name" className="text-sm font-medium">
                  模型名称
                </label>
                <Input
                  id="onboarding-model-name"
                  value={modelName}
                  onChange={(e) => {
                    setModelName(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="gpt-4o-mini"
                />
                <p className="text-xs text-muted-foreground">DeepSeek 用户填写 deepseek-chat</p>
              </div>

              {/* 测试连接 */}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testing || !apiKey || !baseUrl || !modelName}
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
                <Button variant="ghost" onClick={() => setStep(0)}>
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  上一步
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onComplete}>
                    跳过
                  </Button>
                  <Button onClick={() => setStep(2)} disabled={!canProceedFromStep2()}>
                    下一步
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </>
        )}

        {/* Step 2: Try It Out (static preview) */}
        {step === 2 && (
          <>
            <CardHeader>
              <CardTitle>体验预览</CardTitle>
              <p className="text-sm text-muted-foreground">
                这是写作批改功能的示例输出，帮助你了解 Raven 的工作方式
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 原文 */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  输入原文
                </span>
                <div className="p-3 rounded-md bg-muted/50 text-sm leading-relaxed">
                  Yesterday I <span className="text-destructive line-through">go</span> to the
                  library and borrowed two{" "}
                  <span className="text-destructive line-through">book</span>. The librarian was
                  very helpful, she{" "}
                  <span className="text-destructive line-through">recommanded</span> me{" "}
                  <span className="text-destructive line-through">a</span> interesting novel.
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
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  上一步
                </Button>
                <Button onClick={() => setStep(3)}>
                  下一步
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </>
        )}

        {/* Step 3: All Set */}
        {step === 3 && (
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
                {[
                  {
                    icon: BookCheck,
                    label: "Writing Copilot",
                    desc: "左侧导航进入，粘贴英文即可获得批改",
                  },
                  {
                    icon: BookOpen,
                    label: "Reading Copilot",
                    desc: "输入英文文章，获取六维深度分析",
                  },
                  {
                    icon: Brain,
                    label: "间隔复习",
                    desc: "阅读时添加生词，自动进入复习计划",
                  },
                  {
                    icon: Target,
                    label: "弱项训练",
                    desc: "系统分析你的薄弱点，生成专项练习",
                  },
                ].map(({ icon: Icon, label, desc }) => (
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
                <Button onClick={handleFinish} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  开始使用
                </Button>
              </div>
            </CardContent>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
