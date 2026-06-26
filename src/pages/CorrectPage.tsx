/**
 * @module CorrectPage
 * @description 写作纠错页面（Writing Copilot）。
 *
 * 提供英文写作智能纠错功能，核心流程：
 * 1. 用户输入英文文本
 * 2. 通过 LLM 流式调用获取纠错结果
 * 3. 解析结构化 JSON 并渲染纠错报告（修正文本、错误列表、总结建议）
 *
 * 主要特性：
 * - 个性化 prompt：基于用户近期错误历史注入上下文
 * - 流式响应：使用 useLLMStreamPage 模板方法 hook 统一管理状态
 * - 生词本集成：支持将错误原文一键添加到生词本
 * - 独立错误边界：解析异常不影响页面其他部分
 */

import {
  BookCheck,
  CheckCircle2,
  ClipboardList,
  Copy,
  Lightbulb,
  Loader2,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { EmptyState, ErrorBanner, WarningBanner } from "@/components/page-states";
import { SpeakButton } from "@/components/SpeakButton";
import { TextInput } from "@/components/TextInput";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { buildPersonalizedContext } from "@/lib/db";
import { parseCorrectionJson } from "@/lib/parse-utils";
import { CORRECT_PROMPT } from "@/prompts";

/**
 * 写作纠错页面（Writing Copilot）。
 *
 * 核心流程：用户输入 → LLM 流式纠错 → 解析 JSON → 展示纠错报告。
 * 通过 PersistentRoutes 保持挂载，切换页面不丢失状态。
 *
 * 使用 useLLMStreamPage 模板方法 hook 统一管理：
 * result state、历史持久化、学习活动记录、错误处理。
 */
export default function CorrectPage() {
  const [input, setInput] = useState("");
  /** 历史写入失败时的警告信息（BUG-04a 修复：之前静默失败） */
  const [saveError, setSaveError] = useState<string | null>(null);

  // 模板方法 hook：封装 result state + 流式调用 + 历史持久化 + 学习打卡
  const {
    loading,
    error: streamError,
    result,
    handleSubmit,
  } = useLLMStreamPage({
    activityType: "writing",
    // 异步构建个性化 prompt：查询近期错误历史注入到 system prompt
    buildMessages: async (textInput) => {
      const context = await buildPersonalizedContext();
      const personalizedPrompt = context ? `${CORRECT_PROMPT}\n\n${context}` : CORRECT_PROMPT;
      return [personalizedPrompt, textInput];
    },
    // 历史记录统一使用 "correct" 类型，与早期 schema 保持一致
    buildHistoryRecord: (input, fullText) => ({
      type: "correct",
      input_text: input,
      result: fullText,
    }),
    // 历史写入失败时显示警告横幅，不阻塞纠错结果展示
    onHistoryError: (msg) => setSaveError(`纠错结果保存失败，但内容仍已显示：${msg}`),
  });

  // 共享的"添加到生词本" hook
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  const handleAddToVocabulary = (original: string) => {
    addToVocabulary(original, input, "correct");
  };

  async function handleCorrect() {
    if (!input.trim()) return;
    setSaveError(null);
    await handleSubmit(input);
  }

  const parsed = useMemo(
    () => (result && !loading ? parseCorrectionJson(result) : null),
    [result, loading],
  );

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">Writing Copilot</h2>

      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleCorrect}
        placeholder="输入英文文本..."
        loading={loading}
        submitLabel="Check Writing"
      />

      {streamError && <ErrorBanner message={streamError} />}

      {/* 历史写入失败警告（不阻塞纠错结果显示） */}
      {saveError && !streamError && <WarningBanner message={saveError} />}

      {!result && !loading && !streamError && (
        <EmptyState
          icon={BookCheck}
          title="粘贴英文文本，开始智能纠错"
          subtitle="支持语法检查、拼写纠正、写作风格建议"
        />
      )}

      {/* 纠错结果展示区 — 独立错误边界，防止解析异常导致页面崩溃 */}
      {result && parsed && (
        <InlineErrorBoundary sectionName="纠错结果">
          <div className="space-y-5">
            <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-5">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                <span className="font-semibold text-green-700 dark:text-green-300">Corrected</span>
                <SpeakButton text={parsed.corrected_text} />
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(parsed.corrected_text)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => setInput(parsed.corrected_text)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Replace
                  </button>
                </div>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{parsed.corrected_text}</p>
            </div>

            {parsed.corrections.length > 0 && (
              <div className="space-y-4">
                <h3 className="flex items-center gap-2 font-semibold text-sm">
                  <ClipboardList className="h-4 w-4" />
                  Corrections
                </h3>

                {parsed.corrections.map((c) => (
                  <div
                    key={c.original}
                    className="rounded-lg border border-border/60 bg-card p-4 space-y-2"
                  >
                    <div className="text-sm flex items-center gap-1">
                      <span className="line-through text-red-500/80">{c.original}</span>
                      <SpeakButton text={c.original} />
                      {addedWords.has(c.original) ? (
                        <span className="inline-flex items-center gap-0.5 text-xs text-green-600 dark:text-green-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          已添加
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddToVocabulary(c.original);
                          }}
                          disabled={addingWord === c.original}
                          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          title="加入生词本"
                        >
                          {addingWord === c.original ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5" />
                          )}
                          加入生词本
                        </button>
                      )}
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className="font-semibold text-green-600 dark:text-green-400">
                        {c.corrected}
                      </span>
                      <SpeakButton text={c.corrected} />
                    </div>
                    <div>
                      <span className="inline-block rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs px-2.5 py-0.5 font-medium">
                        {c.category}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{c.explanation}</p>
                  </div>
                ))}
              </div>
            )}

            {parsed.summary && (
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 flex gap-3">
                <Lightbulb className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                <p className="text-sm leading-relaxed text-muted-foreground">{parsed.summary}</p>
              </div>
            )}
          </div>
        </InlineErrorBoundary>
      )}

      {result && !parsed && (
        <div className="rounded-lg border border-border p-5">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{result}</p>
        </div>
      )}
    </div>
  );
}
