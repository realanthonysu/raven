import { useState, useMemo, useRef } from "react";
import { TextInput } from "@/components/TextInput";
import { streamChat, buildPrompt } from "@/services/llm";
import { getDefaultModel, addHistory } from "@/lib/db";
import { setTaskStatus, markTaskCompleted } from "@/lib/task-status";
import { parseCorrectionJson } from "@/lib/parse-utils";
import { CheckCircle2, ClipboardList, Lightbulb, Copy, RotateCcw, BookCheck } from "lucide-react";
import { SpeakButton } from "@/components/SpeakButton";

/**
 * 写作纠错的系统提示词。
 * 要求 LLM 严格输出 JSON 格式（非 markdown 代码块），包含：
 * - corrected_text: 纠正后的完整文本
 * - corrections: 每个错误的详情（原文、纠正、类别、解释）
 * - summary: 写作建议总结
 *
 * 错误类别标签预定义了 11 种常见类型，LLM 可微调。
 * 注意：LLM 实际输出可能不完全符合 JSON 格式，需要 parseCorrectionJson 做容错解析。
 */
const CORRECT_PROMPT = `你是一个专业的英语纠错助手。用户输入一段英文文本，请完成以下任务：

1. 给出纠正后的完整文本
2. 列出每一个错误的纠正详情
3. 给出一段简短的写作建议

请严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹：

{
  "corrected_text": "纠正后的完整文本",
  "corrections": [
    {
      "original": "错误的原文片段",
      "corrected": "正确的文本",
      "category": "错误类别",
      "explanation": "中文解释说明"
    }
  ],
  "summary": "中文写作建议总结"
}

错误类别使用以下标签之一（可根据实际情况微调）：
主谓一致 / 冠词错误 / 单复数 / 用词不当 / 时态错误 / 拼写错误 / 介词错误 / 句式杂糅 / 标点错误 / 缺少成分 / 语序错误

注意事项：
- 每个错误单独列出一条 correction
- 如果原文没有错误，corrections 返回空数组，summary 写"表达准确，无需修改。"
- explanation 用中文解释
- 不要遗漏任何错误`;

/**
 * 写作纠错页面（Writing Copilot）。
 *
 * 核心流程：
 * 1. 用户输入英文文本 → 2. 调用 LLM 流式纠错 → 3. 解析 JSON 结果 → 4. 展示纠错报告
 *
 * 状态管理：
 * - input: 用户输入的原始文本
 * - result: LLM 流式返回的原始字符串（逐 token 拼接）
 * - loading: 是否正在等待 LLM 响应
 * - abortRef: AbortController 引用，用于取消上一次未完成的请求（避免重复提交）
 *
 * 与其他模块的关系：
 * - 通过 PersistentRoutes 保持挂载，切换页面不丢失状态
 * - 纠错完成后自动写入 history 表（type="correct"）
 * - 通过 task-status 模块通知 Layout 显示任务状态（蓝色转圈/绿色完成）
 * - parseCorrectionJson 做 JSON 容错解析，失败时回退显示原始文本
 */
export default function CorrectPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  /** 用于取消上一次未完成的流式请求，重新提交时先 abort */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 提交纠错请求。
   * 处理流程：取消旧请求 → 校验模型配置 → 流式调用 LLM → 持久化结果。
   * 使用 AbortController 实现请求取消：
   * - 每次提交时 abort 旧请求，创建新 controller
   * - 注册 abort 事件监听器清理 loading 状态（因为被 abort 的 streamChat 不会触发 onDone/onError）
   */
  async function handleCorrect() {
    if (!input.trim()) return;

    // 取消上一次未完成的请求
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const model = await getDefaultModel();
    if (!model?.api_key) {
      setResult("错误：请先在设置页面配置 LLM 模型。");
      return;
    }

    setLoading(true);
    setTaskStatus("writing", true); // 通知 Layout 显示任务运行中状态
    setResult("");

    // 当请求被 abort 时，streamChat 会静默返回（不触发 onDone/onError），
    // 所以需要通过 signal 事件来清理 loading 和 taskStatus。
    controller.signal.addEventListener("abort", () => {
      setLoading(false);
      setTaskStatus("writing", false);
    }, { once: true });

    const messages = buildPrompt(CORRECT_PROMPT, input);

    await streamChat(
      messages,
      model,
      {
        // 每收到一个 token 就追加到 result，实现流式显示效果
        onToken: (token) => setResult((prev) => prev + token),
        onDone: (fullText) => {
          setLoading(false);
          markTaskCompleted("writing"); // 通知 Layout 显示绿色完成标记
          // 将完整结果持久化到 SQLite history 表（fire-and-forget，失败不影响用户体验）
          addHistory({ type: "correct", input_text: input, result: fullText }).catch(console.warn);
        },
        onError: (error) => {
          setLoading(false);
          setTaskStatus("writing", false); // 出错时清除任务状态
          setResult(`错误：${error.message}`);
        },
      },
      controller.signal
    );
  }

  /**
   * 将 LLM 返回的原始字符串解析为结构化 JSON。
   * 仅在 loading 结束后解析（避免解析不完整的 JSON）。
   * useMemo 依赖 [result, loading]：result 变化时重新解析，loading 为 true 时跳过。
   */
  const parsed = useMemo(
    () => (result && !loading ? parseCorrectionJson(result) : null),
    [result, loading]
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

      {/* 空状态引导：未输入且未加载时显示 */}
      {!result && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BookCheck className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">粘贴英文文本，开始智能纠错</p>
          <p className="text-sm mt-1">支持语法检查、拼写纠正、写作风格建议</p>
        </div>
      )}

      {/* 纠错结果展示（JSON 解析成功时） */}
      {result && parsed && (
        <div className="space-y-5">
          {/* 纠正后的完整文本区块，提供"复制"和"替换输入"两个快捷操作 */}
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
                {/* Replace 将纠正文本回填到输入框，方便用户基于纠正结果继续编辑 */}
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

          {/* 逐条纠错详情列表 */}
          {parsed.corrections.length > 0 && (
            <div className="space-y-4">
              <h3 className="flex items-center gap-2 font-semibold text-sm">
                <ClipboardList className="h-4 w-4" />
                Corrections
              </h3>

              {parsed.corrections.map((c, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/60 bg-card p-4 space-y-2"
                >
                  {/* 原文 → 纠正 的对照展示 */}
                  <div className="text-sm flex items-center gap-1">
                    <span className="line-through text-red-500/80">{c.original}</span>
                    <SpeakButton text={c.original} />
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="font-semibold text-green-600 dark:text-green-400">{c.corrected}</span>
                    <SpeakButton text={c.corrected} />
                  </div>
                  {/* 错误类别标签（如"时态错误"、"主谓一致"等） */}
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

          {/* 写作建议总结 */}
          {parsed.summary && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 flex gap-3">
              <Lightbulb className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
              <p className="text-sm leading-relaxed text-muted-foreground">{parsed.summary}</p>
            </div>
          )}
        </div>
      )}

      {/* 降级渲染：JSON 解析失败时（LLM 输出格式异常），直接显示原始文本 */}
      {result && !parsed && (
        <div className="rounded-lg border border-border p-5">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{result}</p>
        </div>
      )}
    </div>
  );
}
