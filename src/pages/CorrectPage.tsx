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
import { EmptyState, ErrorBanner } from "@/components/page-states";
import { SpeakButton } from "@/components/SpeakButton";
import { TextInput } from "@/components/TextInput";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, buildPersonalizedContext } from "@/lib/db";
import { parseCorrectionJson } from "@/lib/parse-utils";
import { CORRECT_PROMPT } from "@/prompts";

/**
 * 写作纠错页面（Writing Copilot）。
 *
 * 核心流程：用户输入 → LLM 流式纠错 → 解析 JSON → 展示纠错报告。
 * 通过 PersistentRoutes 保持挂载，切换页面不丢失状态。
 */
export default function CorrectPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const hookOptions = useMemo(() => ({}), []);
  const { loading, error: streamError, setError, execute } = useStreamChat("writing", hookOptions);

  // 共享的"添加到生词本" hook
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  const handleAddToVocabulary = (original: string) => {
    addToVocabulary(original, input, "correct");
  };

  async function handleCorrect() {
    if (!input.trim()) return;
    setResult("");

    const context = await buildPersonalizedContext();
    const personalizedPrompt = context ? `${CORRECT_PROMPT}\n\n${context}` : CORRECT_PROMPT;

    await execute(personalizedPrompt, input, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: (fullText) => {
        addHistorySafe({ type: "correct", input_text: input, result: fullText });
      },
      onError: (error) => {
        setError(error.message);
      },
    });
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

      {!result && !loading && !streamError && (
        <EmptyState
          icon={BookCheck}
          title="粘贴英文文本，开始智能纠错"
          subtitle="支持语法检查、拼写纠正、写作风格建议"
        />
      )}

      {result && parsed && (
        <div className="space-y-5">
          <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-5">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
              <span className="font-semibold text-green-700 dark:text-green-300">Corrected</span>
              <SpeakButton text={parsed.corrected_text} />
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(parsed.corrected_text)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
                <button
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

              {parsed.corrections.map((c, i) => (
                <div key={i} className="rounded-lg border border-border/60 bg-card p-4 space-y-2">
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
      )}

      {result && !parsed && (
        <div className="rounded-lg border border-border p-5">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{result}</p>
        </div>
      )}
    </div>
  );
}
