/**
 * @module ReadingPage
 * @description 阅读精读页面（Reading Copilot）。
 *
 * 提供英文文章的六维深度精读分析功能。
 * 三步串行流程：
 * 1. 语言检测 — 调用 LLM 判断输入是否为英文，非英文则拦截
 * 2. 六维分析 — 流式调用 LLM 按 ## 标题输出翻译、词汇、句式、语法、背景、思考六个维度
 * 3. 知识图谱 — 分析完成后异步调用 LLM 生成概念关系图谱（不阻塞主流程）
 *
 * 主要特性：
 * - 模板方法 hook（useLLMStreamPage）统一管理流式调用生命周期
 * - 朗读功能（useReadAloud），支持逐句高亮
 * - 单词点击添加到生词本（useAddToVocabulary）
 * - 懒加载知识图谱（KnowledgeGraph），避免增大主 bundle
 */

import {
  BookOpen,
  CheckCircle2,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { EmptyState, ErrorBanner, LoadingIndicator, WarningBanner } from "@/components/page-states";
import { ResultCard } from "@/components/ResultCard";
import { TextInput } from "@/components/TextInput";
import { Button } from "@/components/ui/button";
import { VocabularySection } from "@/components/VocabularySection";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useGraphData } from "@/hooks/use-graph-data";
import { useLanguageDetection } from "@/hooks/use-language-detection";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { useReadAloud } from "@/hooks/use-read-aloud";
import { getDefaultModelCached } from "@/lib/db";
import { parseSections, splitSentences } from "@/lib/parse-utils";
import { readingSectionConfig } from "@/lib/type-config";
import { READING_PROMPT } from "@/prompts";

/** Lazy-loaded KnowledgeGraph to keep cytoscape.js (~200KB) out of the main bundle */
const KnowledgeGraph = lazy(() =>
  import("@/components/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph })),
);

/**
 * 阅读精读页面（Reading Copilot）。
 *
 * 核心流程（三步串行）：
 * 1. 语言检测 — 调用 LLM 判断是否为英文，非英文则拦截
 * 2. 六维分析 — 流式调用 LLM 按 ## 标题输出六个维度的分析（由 useLLMStreamPage 管理）
 * 3. 知识图谱 — 分析完成后异步调用 LLM 生成概念关系图谱（不阻塞主流程）
 *
 * 使用 useLLMStreamPage 模板方法 hook 管理核心流式调用生命周期，
 * 页面层保留语言检测前置校验和图谱生成后处理。
 */
export default function ReadingPage() {
  const [input, setInput] = useState("");
  const [selectedWord, setSelectedWord] = useState<string | null>(null);

  // --- 语言检测 ---
  const { detecting, detectLanguage, cancelDetection } = useLanguageDetection();

  // --- 知识图谱 ---
  // BUG-04b 修复：解析 graphError 并在 UI 中显示，之前图谱失败时无任何反馈
  const { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph } =
    useGraphData();

  // --- 模板方法 hook：管理 result state + 流式调用 + 历史持久化 + 学习打卡 ---
  const { loading, error, setError, result, setResult, abort, handleSubmit } = useLLMStreamPage({
    activityType: "reading",
    buildMessages: (textInput) => [READING_PROMPT, textInput],
    // 分析完成后异步生成知识图谱（historyId 用于更新 history 表的 graph_data 字段）
    onDone: (_fullText, historyId) => {
      fetchGraph(input, historyId ?? undefined);
    },
  });

  // --- 朗读 ---
  const { readAloudActive, currentSentenceIndex, startReadAloud, stopReadAloud } =
    useReadAloud(input);

  // --- 生词本（共享 hook） ---
  const { enriching, addToVocabulary } = useAddToVocabulary();

  /**
   * 提交精读分析请求。
   * 串行执行：语言检测 → 六维分析（handleSubmit） → 异步知识图谱（onDone 回调）。
   *
   * 语言检测在 handleSubmit 之前执行，因为非英文输入应直接拦截，
   * 不应触发 LLM 流式调用和历史持久化。
   */
  async function handleAnalyze() {
    if (!input.trim()) return;

    stopReadAloud();
    cancelDetection();
    cancelGraph();
    abort();

    const model = await getDefaultModelCached();
    if (!model?.api_key) {
      setError("请先在设置页面配置 LLM 模型。");
      return;
    }

    // === 第一步：语言检测（前置校验） ===
    setError(null);
    clearGraph();

    const detected = await detectLanguage(input, model);
    if (!detected.isEnglish) {
      setError(`Reading Copilot 仅支持英文输入。${detected.reason || ""}`);
      return;
    }

    // === 第二步：六维精读分析（由 useLLMStreamPage 编排） ===
    // === 第三步：异步知识图谱（在 onDone 回调中触发） ===
    await handleSubmit(input);
  }

  /** 重置页面状态，开始新文章 */
  function handleReset() {
    stopReadAloud();
    cancelDetection();
    cancelGraph();
    abort();
    setInput("");
    setResult("");
    setError(null);
    clearGraph();
    setSelectedWord(null);
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

      <div className="space-y-3">
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleAnalyze}
          placeholder="粘贴英文文章..."
          loading={loading || detecting}
          submitLabel="Start Reading"
        />
        {result && !loading && !detecting && (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={handleReset}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              新文章
            </Button>
          </div>
        )}
      </div>

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
                  <button
                    key={`${sentIdx}-${wordIdx}`}
                    type="button"
                    className="hover:bg-primary/10 hover:rounded px-0.5 cursor-pointer inline bg-transparent border-none p-0 font-inherit text-inherit"
                    onClick={() => handleWordClick(word)}
                  >
                    {word}
                  </button>
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

      {/* 知识图谱加载中 */}
      {graphLoading && !graphData && <LoadingIndicator text="正在生成知识图谱..." />}

      {/* 知识图谱 — 独立错误边界，防止 Cytoscape 崩溃波及其他区域 */}
      {graphData && (
        <ResultCard
          title="知识图谱"
          icon={<Network className="h-4 w-4" />}
          variant="highlight"
          collapsible
          defaultExpanded={false}
        >
          <InlineErrorBoundary sectionName="知识图谱">
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-[500px] border rounded-md bg-muted/30">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <KnowledgeGraph data={graphData} />
            </Suspense>
          </InlineErrorBoundary>
        </ResultCard>
      )}

      {/* BUG-04b 修复：图谱生成失败时显示警告，之前无任何用户反馈 */}
      {graphError && !graphData && <WarningBanner message={`知识图谱生成失败：${graphError}`} />}
    </div>
  );
}
