import { BookOpen, CheckCircle2, Loader2, Network, Plus, Square, Volume2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import { EmptyState, ErrorBanner, LoadingIndicator } from "@/components/page-states";
import { ResultCard } from "@/components/ResultCard";
import { TextInput } from "@/components/TextInput";
import { Button } from "@/components/ui/button";
import { VocabularySection } from "@/components/VocabularySection";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useGraphData } from "@/hooks/use-graph-data";
import { useLanguageDetection } from "@/hooks/use-language-detection";
import { useReadAloud } from "@/hooks/use-read-aloud";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, getDefaultModel } from "@/lib/db";
import { parseSections, splitSentences } from "@/lib/parse-utils";
import { readingSectionConfig } from "@/lib/type-config";
import { READING_PROMPT } from "@/prompts";

/**
 * 阅读精读页面（Reading Copilot）。
 *
 * 核心流程（三步串行）：
 * 1. 语言检测 — 调用 LLM 判断是否为英文，非英文则拦截
 * 2. 六维分析 — 流式调用 LLM 按 ## 标题输出六个维度的分析
 * 3. 知识图谱 — 分析完成后异步调用 LLM 生成概念关系图谱（不阻塞主流程）
 */
export default function ReadingPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);

  // --- LLM 流式调用 hook ---
  const hookOptions = useMemo(() => ({}), []);
  const { loading, execute, abort } = useStreamChat("reading", hookOptions);

  // --- 语言检测 ---
  const { detecting, detectLanguage, cancelDetection } = useLanguageDetection();

  // --- 知识图谱 ---
  const { graphData, fetchGraph, clearGraph, cancelGraph } = useGraphData();

  // --- 朗读 ---
  const { readAloudActive, currentSentenceIndex, startReadAloud, stopReadAloud, cancelReadAloud } =
    useReadAloud(input);

  // --- 生词本（共享 hook） ---
  const { enriching, addToVocabulary } = useAddToVocabulary();

  /**
   * 提交精读分析请求。
   * 串行执行：语言检测 → 六维分析 → 异步知识图谱。
   */
  async function handleAnalyze() {
    if (!input.trim()) return;

    cancelReadAloud();
    cancelDetection();
    cancelGraph();
    abort();

    const model = await getDefaultModel();
    if (!model?.api_key) {
      setError("请先在设置页面配置 LLM 模型。");
      return;
    }

    // === 第一步：语言检测 ===
    setError(null);
    setResult("");
    clearGraph();

    const detected = await detectLanguage(input, model);
    if (!detected.isEnglish) {
      setError(`Reading Copilot 仅支持英文输入。${detected.reason || ""}`);
      return;
    }

    // === 第二步：六维精读分析 ===
    await execute(READING_PROMPT, input, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: async (fullText) => {
        const historyId = await addHistorySafe({
          type: "reading",
          input_text: input,
          result: fullText,
        });
        // 第三步：异步生成知识图谱
        fetchGraph(input, historyId ?? undefined);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  }

  /** 原文中单词的点击处理器 */
  const handleWordClick = useCallback((word: string) => {
    const cleaned = word.replace(/[^a-zA-Z'-]/g, "");
    if (cleaned.length > 1) setSelectedWord(cleaned);
  }, []);

  /** 将选中的单词添加到生词本 */
  async function handleAddToVocabulary() {
    if (!selectedWord) return;
    await addToVocabulary(selectedWord, input.substring(0, 200), "reading");
    setSelectedWord(null);
  }

  const sections = useMemo(() => parseSections(result), [result]);
  const hasSections = Object.values(sections).some((v) => v.length > 0);

  const visibleSections = Object.entries(readingSectionConfig)
    .filter(([key]) => sections[key])
    .map(([key, config], _i, arr) => ({
      key,
      title: `${Object.keys(readingSectionConfig).indexOf(key) + 1}/${arr.length} ${config.title}`,
      icon: config.icon,
    }));

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">Reading Copilot</h2>

      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleAnalyze}
        placeholder="粘贴英文文章..."
        loading={loading || detecting}
        submitLabel="Start Reading"
      />

      {error && <ErrorBanner message={error} />}
      {detecting && <LoadingIndicator text="正在检测语言..." />}

      {/* 原文展示区 */}
      {result && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            <span className="font-semibold text-green-700 dark:text-green-300">Original</span>
            <Button
              size="sm"
              variant={readAloudActive ? "secondary" : "outline"}
              className="ml-auto"
              onClick={readAloudActive ? stopReadAloud : startReadAloud}
            >
              {readAloudActive ? (
                <>
                  <Square className="h-3.5 w-3.5 mr-1" />
                  停止朗读
                </>
              ) : (
                <>
                  <Volume2 className="h-3.5 w-3.5 mr-1" />
                  朗读
                </>
              )}
            </Button>
          </div>
          <div className="text-sm leading-relaxed">
            {splitSentences(input).map((sentence, sentIdx) => (
              <span
                key={sentIdx}
                className={
                  sentIdx === currentSentenceIndex
                    ? "bg-yellow-200/50 dark:bg-yellow-500/20 rounded"
                    : ""
                }
              >
                {sentence.split(/(\s+)/).map((word, wordIdx) => (
                  <span
                    key={`${sentIdx}-${wordIdx}`}
                    className="hover:bg-primary/10 hover:rounded px-0.5 cursor-pointer"
                    onClick={() => handleWordClick(word)}
                  >
                    {word}
                  </span>
                ))}{" "}
              </span>
            ))}
          </div>
          {selectedWord && (
            <div className="flex items-center justify-between pt-3 border-t border-green-500/20">
              <span className="text-sm font-medium">选中：{selectedWord}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddToVocabulary}
                disabled={enriching}
              >
                {enriching ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    补全中...
                  </>
                ) : (
                  <>
                    <Plus className="h-3 w-3 mr-1" />
                    添加到生词本
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 空状态 */}
      {!result && !loading && !detecting && !error && (
        <EmptyState
          icon={BookOpen}
          title="粘贴英文文章，开始深度精读"
          subtitle="提供翻译、词汇、句式、语法、背景、思考六个维度分析"
        />
      )}

      {loading && !sections.参考翻译 && <LoadingIndicator text="正在分析..." className="h-24" />}

      {/* 六维分析结果 */}
      {visibleSections.map((sec) => (
        <ResultCard key={sec.key} title={sec.title} icon={sec.icon} collapsible>
          {sec.key === "重点词汇" ? (
            <VocabularySection content={sections[sec.key]} sourceText={input} />
          ) : (
            <ReactMarkdown>{sections[sec.key]}</ReactMarkdown>
          )}
        </ResultCard>
      ))}

      {/* 降级：有结果但未能按 ## 标题拆分 */}
      {result && !loading && !hasSections && (
        <ResultCard title="分析结果" icon={<BookOpen className="h-4 w-4" />} collapsible>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{result}</ReactMarkdown>
          </div>
        </ResultCard>
      )}

      {/* 知识图谱 */}
      {graphData && (
        <ResultCard
          title="知识图谱"
          icon={<Network className="h-4 w-4" />}
          variant="highlight"
          collapsible
          defaultExpanded={false}
        >
          <KnowledgeGraph data={graphData} />
        </ResultCard>
      )}
    </div>
  );
}
