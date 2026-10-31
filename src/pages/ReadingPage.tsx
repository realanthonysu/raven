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
 * - 难度适配：按用户 CEFR 级别（useProficiencyLevel / getProficiencyLevel）构建六维分析提示词，级别徽章展示在输入区顶部
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
import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { MarkdownContent } from "@/components/MarkdownContent";
import { EmptyState, ErrorBanner, LoadingIndicator, WarningBanner } from "@/components/page-states";
import { ResultCard } from "@/components/ResultCard";
import { TextInput } from "@/components/TextInput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VocabularySection } from "@/components/VocabularySection";
import { usePageHidden } from "@/contexts/PageVisibilityContext";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useGraphData } from "@/hooks/use-graph-data";
import { useHiddenEffect } from "@/hooks/use-hidden-effect";
import { useLanguageDetection } from "@/hooks/use-language-detection";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { useReadAloud } from "@/hooks/use-read-aloud";
import { getProficiencyLevel } from "@/lib/db";
import { type LevelCode, levelLabel } from "@/lib/levels";
import { parseSections, splitSentences } from "@/lib/parse-utils";
import { READING_SECTION_KEY, readingSectionConfig } from "@/lib/type-config";
import { buildReadingPrompt } from "@/prompts";

/** Lazy-loaded KnowledgeGraph to keep cytoscape.js (~200KB) out of the main bundle */
const KnowledgeGraph = lazy(() =>
  import("@/components/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph })),
);

/** 流式预览只保留末尾片段：长文章全文每次 flush 都要重序列化，代价 O(n) */
const STREAM_PREVIEW_TAIL_CHARS = 2000;

/**
 * 流式期间的原始 Markdown 预览。只渲染末尾若干字符，
 * 避免每 50ms flush 时对 10–50KB 全文做一次 React 文本 reconcile。
 */
const StreamPreview = memo(function StreamPreview({ result }: { result: string }) {
  const isTruncated = result.length > STREAM_PREVIEW_TAIL_CHARS;
  let preview = isTruncated ? result.slice(-STREAM_PREVIEW_TAIL_CHARS) : result;
  // UTF-16 截断可能劈开代理对：首字符是低代理项（0xDC00-0xDFFF）说明前一
  // 个码元（高代理项）被切掉，丢弃这个孤立半个字符避免显示 �
  if (preview.length > 0) {
    const firstCode = preview.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      preview = preview.slice(1);
    }
  }
  return (
    <div className="rounded-lg border p-5 space-y-2">
      <div className="text-sm font-semibold">
        分析结果（生成中…）
        {isTruncated && <span className="ml-2 font-normal text-muted-foreground">仅显示末尾</span>}
      </div>
      <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{preview}</pre>
    </div>
  );
});

/**
 * 流式期间的空 sections 常量：loading 时跳过 parseSections + Markdown 重渲染，
 * 长文章避免每 50ms 对累积全文做 O(n²) 的重复解析掉帧。
 */
const EMPTY_SECTIONS: Record<string, string> = {};

/**
 * 单句行 —— 原文词表的细粒度 memo 单元。
 *
 * `tokens` 由父级 useMemo 按句缓存（引用稳定），`active` 只在朗读切句时变化：
 * 因此切句只重渲染「上一句 + 当前句」两行，而不是整篇文章的所有词按钮。
 */
const SentenceRow = memo(function SentenceRow({
  tokens,
  active,
  onWordClick,
}: {
  tokens: string[];
  active: boolean;
  onWordClick: (word: string) => void;
}) {
  return (
    <span className={active ? "bg-yellow-200/50 dark:bg-yellow-500/20 rounded" : ""}>
      {tokens.map((token, tokenIdx) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: token 数组按句稳定、不重排
          key={tokenIdx}
          type="button"
          className="hover:bg-primary/10 hover:rounded px-0.5 cursor-pointer inline bg-transparent border-none p-0 font-inherit text-inherit"
          onClick={() => onWordClick(token)}
        >
          {token}
        </button>
      ))}{" "}
    </span>
  );
});

/**
 * 原文逐词展示区块。
 *
 * 独立 memo 组件：流式期间 result 每个 token flush（~20fps）都会重渲页面，
 * 长文章数千个单词按钮的 reconcile 是主要掉帧来源；memo 后仅当
 * 原文分句、朗读高亮句或点击回调变化时才重渲本区块。
 * 分句后的 token 数组由父级 useMemo 预计算（`sentenceTokens`），切句时
 * 只有 `SentenceRow` 的 active 变化会穿透 memo。
 */
const OriginalText = memo(function OriginalText({
  sentenceTokens,
  currentSentenceIndex,
  onWordClick,
}: {
  sentenceTokens: string[][];
  currentSentenceIndex: number;
  onWordClick: (word: string) => void;
}) {
  return (
    <div className="text-sm leading-relaxed">
      {sentenceTokens.map((tokens, sentIdx) => (
        <SentenceRow
          // biome-ignore lint/suspicious/noArrayIndexKey: 句子顺序稳定，内容键会因重复句子碰撞
          key={sentIdx}
          tokens={tokens}
          active={sentIdx === currentSentenceIndex}
          onWordClick={onWordClick}
        />
      ))}
    </div>
  );
});

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
  // 提交分析时快照输入，供 onDone 生成知识图谱使用。
  // 不能用最新 input(PersistentRoutes 保持组件挂载)也不能用 onDone 闭包捕获值:
  // 流式期间用户编辑 textarea 会让 inputRef 读到新文本,导致 history 记录旧文本分析、
  // graph_data 却是新文本图谱的数据错位
  const submittedInputRef = useRef("");
  // 最近一次分析使用的 CEFR 级别：buildMessages 异步读取后写入，
  // 供 hook 的 getDifficultyLevel 在持久化时快照（避免水合延迟导致错配）
  const lastLevelRef = useRef<LevelCode | null>(null);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);

  // --- 当前英语水平级别（全局 store，输入区徽章展示） ---
  const { level } = useProficiencyLevel();

  // --- 语言检测 ---
  const { detecting, detectLanguage, cancelDetection } = useLanguageDetection();

  // --- 知识图谱 ---
  // BUG-04b 修复：解析 graphError 并在 UI 中显示，之前图谱失败时无任何反馈
  const { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph } =
    useGraphData();

  // --- 模板方法 hook：管理 result state + 流式调用 + 历史持久化 + 学习打卡 ---
  const { loading, error, setError, result, setResult, abort, handleSubmit } = useLLMStreamPage({
    activityType: "reading",
    // 级别在提交时从 DB 异步读取（水合延迟不影响正确性），
    // 写入 lastLevelRef 供 getDifficultyLevel 持久化快照
    buildMessages: async (textInput) => {
      const level = await getProficiencyLevel();
      lastLevelRef.current = level;
      return [buildReadingPrompt(level), textInput];
    },
    getDifficultyLevel: () => lastLevelRef.current,
    // 分析完成后异步生成知识图谱（historyId 用于更新 history 表的 graph_data 字段）
    // 使用提交时的输入快照，避免流式期间编辑导致图谱与历史记录错位
    onDone: (_fullText, historyId) => {
      fetchGraph(submittedInputRef.current, historyId ?? undefined);
    },
  });

  // --- 朗读 ---
  const { readAloudActive, currentSentenceIndex, startReadAloud, stopReadAloud } =
    useReadAloud(input);

  // PersistentRoutes 以 CSS display 切换保持本页常驻挂载：离开页面不会卸载，
  // useReadAloud 的 unmount 清理永远不会执行，朗读循环会继续逐句播放。
  // 借助 useHiddenEffect 在"被隐藏的瞬间"停止朗读
  // （行为变更：此前导航离开后朗读会继续播放到文章结束）。
  // 「是否被壳隐藏」由路由壳经 PageVisibilityContext 单向下发（usePageHidden）；
  // useHiddenEffect 的首参是 visible，故取反。
  useHiddenEffect(!usePageHidden("reading"), stopReadAloud);

  // 原文分句 + 逐词预切分：memo 化避免流式期间每个 token flush 都重新执行
  // splitSentences；token 数组引用稳定，SentenceRow 的 memo 才能只按 active 更新。
  const originalSentenceTokens = useMemo(
    () => splitSentences(input).map((sentence) => sentence.split(/(\s+)/)),
    [input],
  );

  // --- 生词本（共享 hook） ---
  const { enriching, addedWords, addToVocabulary } = useAddToVocabulary();

  /**
   * 提交精读分析请求。
   * 串行执行：语言检测（模型解析已收编进检测 hook） → 六维分析（handleSubmit） → 异步知识图谱（onDone 回调）。
   *
   * 语言检测在 handleSubmit 之前执行：非英文输入（含检测内部报模型未配置/服务
   * 不可用的 fail-closed 结果）应直接拦截，不应触发 LLM 流式调用和历史持久化。
   *
   * useCallback：TextInput 经 memo 包裹，流式期间 onSubmit 身份抖动会击穿 memo。
   */
  const handleAnalyze = useCallback(async () => {
    if (!input.trim()) return;

    stopReadAloud();
    cancelDetection();
    cancelGraph();
    abort();

    // === 第一步：语言检测（前置校验） ===
    setError(null);
    clearGraph();

    const detected = await detectLanguage(input);
    // 检测被中止（用户点击重置/重新提交）：放弃本次流程，不再提交旧文本分析
    if (!detected) return;
    if (!detected.isEnglish) {
      setError(`Reading Copilot 仅支持英文输入。${detected.reason || ""}`);
      return;
    }

    // === 第二步：六维精读分析（由 useLLMStreamPage 编排） ===
    // === 第三步：异步知识图谱（在 onDone 回调中触发） ===
    // 快照提交时的输入，供 onDone 生成图谱 —— 避免流式期间编辑导致数据错位
    submittedInputRef.current = input;
    await handleSubmit(input);
  }, [
    input,
    stopReadAloud,
    cancelDetection,
    cancelGraph,
    abort,
    setError,
    clearGraph,
    detectLanguage,
    handleSubmit,
  ]);

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

  const sections = useMemo(
    () => (loading ? EMPTY_SECTIONS : parseSections(result)),
    [result, loading],
  );
  const hasSections = Object.values(sections).some((v) => v.length > 0);

  const visibleSections = useMemo(
    () =>
      Object.entries(readingSectionConfig)
        .filter(([key]) => sections[key])
        .map(([key, config]) => ({
          key,
          // 分母固定为六维分析的维度总数：LLM 少输出一节时，
          // 用过滤后数量做分母会出现 "6/5" 这类非法分数
          title: `${Object.keys(readingSectionConfig).indexOf(key) + 1}/${Object.keys(readingSectionConfig).length} ${config.title}`,
          icon: config.icon,
        })),
    [sections],
  );

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">Reading Copilot</h2>

      <div className="space-y-3">
        {/* 当前级别徽章：提示用户内容将按其水平生成；修改入口在设置 → 英语水平定级 */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>当前级别</span>
          <Badge variant="outline" className="font-normal">
            {levelLabel(level)}
          </Badge>
        </div>
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

      {/* 原文展示区：延迟到流式结束（!loading）再挂载——整篇逐词按钮只在结果
          可用后构建一次，避免长文首个 token flush 时与流式预览一起承担挂载成本；
          流式期间输入内容仍由上方 TextInput 保留展示。 */}
      {result && !loading && (
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
          <OriginalText
            sentenceTokens={originalSentenceTokens}
            currentSentenceIndex={currentSentenceIndex}
            onWordClick={handleWordClick}
          />
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

      {loading && !result && <LoadingIndicator text="正在分析..." className="h-24" />}

      {/* 流式预览：loading 期间跳过 parseSections/ResultCard 全量管线，
          只渲染末尾片段，避免长文章每 flush 重序列化全文掉帧 */}
      {loading && result && <StreamPreview result={result} />}

      {/* 六维分析结果 */}
      {visibleSections.map((sec) => (
        <ResultCard key={sec.key} title={sec.title} icon={sec.icon} collapsible>
          {sec.key === READING_SECTION_KEY.vocabulary ? (
            <VocabularySection content={sections[sec.key]} sourceText={input} />
          ) : (
            <MarkdownContent content={sections[sec.key]} />
          )}
        </ResultCard>
      ))}

      {/* 降级：有结果但未能按 ## 标题拆分 */}
      {result && !loading && !hasSections && (
        <ResultCard title="分析结果" icon={<BookOpen className="h-4 w-4" />} collapsible>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownContent content={result} />
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
              <KnowledgeGraph
                data={graphData}
                onAddWord={(word) => addToVocabulary(word, input.substring(0, 200), "reading")}
                addedWords={addedWords}
              />
            </Suspense>
          </InlineErrorBoundary>
        </ResultCard>
      )}

      {/* BUG-04b 修复：图谱生成失败时显示警告，之前无任何用户反馈 */}
      {graphError && !graphData && <WarningBanner message={`知识图谱生成失败：${graphError}`} />}
    </div>
  );
}
