import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { TextInput } from "@/components/TextInput";
import { Button } from "@/components/ui/button";
import { ResultCard } from "@/components/ResultCard";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import { streamChat, buildPrompt, enrichWord } from "@/services/llm";
import { getDefaultModel, addHistorySafe, addWord, updateHistoryGraphData } from "@/lib/db";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { splitSentences, parseSections, extractJson } from "@/lib/parse-utils";
import { VocabularySection } from "@/components/VocabularySection";
import { readingSectionConfig } from "@/lib/type-config";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { BookOpen, Network, Plus, CheckCircle2, Volume2, Square, Loader2 } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingIndicator } from "@/components/page-states";
import ReactMarkdown from "react-markdown";

/**
 * 语言检测提示词。
 * 要求 LLM 判断输入文本是否为英文，输出 JSON { isEnglish, reason }。
 * 用于在精读分析前拦截非英文输入，避免浪费 API 调用。
 */
const DETECT_PROMPT = `判断以下文本是否为英文。只输出一个 JSON 对象，不要输出其他内容：
{"isEnglish": true 或 false, "reason": "简短原因（中文）"}

判断标准：
- 如果文本主要是英文（超过80%是英文单词），isEnglish 为 true
- 如果文本主要是中文、日文、韩文等非英文，isEnglish 为 false
- 混合文本以主要语言为准`;

/**
 * 六维精读分析提示词。
 * 定义了 Reading Copilot 的六个分析维度，每个维度用 ## 标题分隔：
 * 1. 参考翻译 — 完整中文翻译
 * 2. 重点词汇 — 5-8 个词汇的音标、释义、搭配、例句
 * 3. 句子拆解 — 长难句的成分标注和结构分析
 * 4. 语法分析 — 语法点名称、规则、用法
 * 5. 背景与技巧 — 领域背景 + 翻译技巧
 * 6. 延伸思考 — 批判性思考和开放性问题
 *
 * parseSections() 按 ## 标题拆分后，每个维度对应一个 ResultCard 渲染。
 */
const READING_PROMPT = `你是一个专业的英语精读助手。用户会输入一段英文文章，请按以下六个维度提供深度分析。

请严格按以下格式输出，每个维度使用一个 ## 标题：

## 参考翻译
给出文章的完整中文翻译。翻译要自然流畅，忠实原文。

## 重点词汇
根据文章长度，选取 5-8 个重点词汇进行分析。每个词汇包含：
- 单词 + 音标
- 文中释义
- 常见搭配（2-3个）
- 一个例句

## 句子拆解
根据文章长度，选取结构复杂的长难句进行拆解分析（最多不超过10个句子）。每个句子包含：
- 原句
- 句子成分标注（主语、谓语、宾语、定语、状语、从句等）
- 中文翻译
- 结构说明

## 语法分析
在原文中选取若干语法点进行分析（最多不超过10个）。每个语法点包含：
- 原文片段
- 语法点名称（如虚拟语气、定语从句、倒装句等）
- 规则说明
- 用法举例

## 背景与技巧
包含两部分：
1. **领域背景**：如果文章涉及特定领域（经济、政策、历史、文学、科技等），说明相关背景知识
2. **翻译技巧**：分析本文翻译中使用的关键技巧（如语序调整、隐喻转化、专业术语处理等）
如果文章不涉及特殊领域，领域背景部分写"本文不涉及特定领域背景。"

## 延伸思考
围绕文章内容进行批判性思考，包含：
- 文章的核心论点或主旨是什么？
- 有哪些值得进一步思考或讨论的观点？
- 与现实生活的联系或启示
- 2-3个开放性思考问题`;

/**
 * 知识图谱生成提示词。
 * 要求 LLM 从文本中提取核心概念和关系，输出 JSON 格式的节点和边。
 * 节点需同时包含中文 label 和英文 labelEn，供 KnowledgeGraph 组件渲染。
 * 图谱数据会持久化到 history 表的 graph_data 字段。
 */
const GRAPH_DATA_PROMPT = `分析以下英文文本，提取其中的核心概念和它们之间的关系，输出为 JSON 格式。

输出格式（严格 JSON，不要包含其他内容）：
{
  "nodes": [
    { "id": "concept1", "label": "中文名称", "labelEn": "English Name", "type": "word|concept|entity" }
  ],
  "edges": [
    { "source": "concept1", "target": "concept2", "relation": "关系描述" }
  ]
}

每个节点必须同时包含 label（中文）和 labelEn（英文）。
关系类型包括：同义、反义、搭配、上下位、因果、对比、包含等。
提取 5-15 个节点，10-30 条边。只输出 JSON，不要其他内容。`;

/**
 * 阅读精读页面（Reading Copilot）。
 *
 * 核心流程（三步串行）：
 * 1. 语言检测 — 调用 LLM 判断是否为英文，非英文则拦截
 * 2. 六维分析 — 流式调用 LLM 按 ## 标题输出六个维度的分析
 * 3. 知识图谱 — 分析完成后异步调用 LLM 生成概念关系图谱（不阻塞主流程）
 *
 * 状态管理：
 * - input: 用户输入的英文原文
 * - result: LLM 流式返回的分析结果（逐 token 拼接）
 * - loading: 六维分析是否进行中
 * - detecting: 语言检测是否进行中
 * - error: 错误信息（模型未配置、语言检测失败等）
 * - selectedWord: 用户在原文中点击选中的单词（用于快速添加到生词本）
 * - graphData: 知识图谱的节点和边数据
 * - useStreamChat hook 管理 AbortController 生命周期和任务状态
 *
 * 与其他模块的关系：
 * - 通过 PersistentRoutes 保持挂载，切换页面不丢失状态
 * - 分析完成后写入 history 表（type="reading"），图谱数据单独更新
 * - 通过 task-status 模块通知 Layout 显示任务状态
 * - KnowledgeGraph 组件使用 Cytoscape.js 渲染图谱
 */
export default function ReadingPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户在原文中点击选中的单词，点击后显示"添加到生词本"按钮 */
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  /** 是否正在补全单词数据（enrichWord 调用中） */
  const [enriching, setEnriching] = useState(false);
  /** 知识图谱数据（nodes + edges），由 fetchGraphData 异步填充 */
  const [graphData, setGraphData] = useState<{
    nodes: { id: string; label: string; type: string }[];
    edges: { source: string; target: string; relation: string }[];
  } | null>(null);
  // --- LLM 流式调用 hook ---
  const hookOptions = useMemo(() => ({}), []);
  const { loading, execute, abort } = useStreamChat("reading", hookOptions);

  // --- 朗读功能 ---
  const [readAloudActive, setReadAloudActive] = useState(false);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const readAloudAbortRef = useRef<AbortController | null>(null);
  const graphAbortRef = useRef<AbortController | null>(null);
  const detectAbortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      readAloudAbortRef.current?.abort();
      graphAbortRef.current?.abort();
      detectAbortRef.current?.abort();
    };
  }, []);

  const { play, stop } = useAudioPlayer({
    onEnd: () => setCurrentSentenceIndex(-1),
  });

  const handleReadAloud = useCallback(async () => {
    readAloudAbortRef.current?.abort();
    const controller = new AbortController();
    readAloudAbortRef.current = controller;

    const sentences = splitSentences(input);
    if (sentences.length === 0) return;

    setReadAloudActive(true);
    setCurrentSentenceIndex(0);

    for (let i = 0; i < sentences.length; i++) {
      if (controller.signal.aborted) break;
      setCurrentSentenceIndex(i);
      try {
        await play(sentences[i]);
      } catch {
        break;
      }
    }

    // Only clean up if this loop's controller is still active
    if (!controller.signal.aborted) {
      setReadAloudActive(false);
      setCurrentSentenceIndex(-1);
    }
  }, [input, play]);

  const handleStopReadAloud = useCallback(() => {
    readAloudAbortRef.current?.abort();
    stop();
    setReadAloudActive(false);
    setCurrentSentenceIndex(-1);
  }, [stop]);

  /**
   * 异步获取知识图谱数据。
   * 在六维分析完成后调用，不阻塞主流程。
   * 解析 LLM 返回的 JSON（兼容 markdown 代码块包裹的情况），
   * 成功后同时更新 React state 和 SQLite history 表。
   *
   * @param text - 原文文本
   * @param historyId - 刚写入的 history 记录 ID，用于后续更新 graph_data 字段
   * @param signal - AbortSignal，请求被取消时静默退出
   */
  async function fetchGraphData(text: string, historyId?: number, signal?: AbortSignal) {
    const model = await getDefaultModel();
    if (!model?.api_key) return;

    const messages = buildPrompt(GRAPH_DATA_PROMPT, text);
    await streamChat(messages, model, {
      onToken: () => {}, // 图谱不需要流式显示，忽略中间 token
      onDone: (fullText) => {
        const parsed = extractJson<{
          nodes: { id: string; label: string; type: string }[];
          edges: { source: string; target: string; relation: string }[];
        }>(fullText);
        if (parsed) {
          setGraphData(parsed);
          // 将图谱数据持久化到 history 记录，以便历史详情页回放
          if (historyId != null && historyId > 0) {
            updateHistoryGraphData(historyId, JSON.stringify(parsed));
          }
        } else {
          console.warn("[graph] parse failed:", fullText);
        }
      },
      onError: (error) => {
        console.warn("[graph] fetch failed:", error);
      },
    }, signal);
  }

  /**
   * 提交精读分析请求。
   * 串行执行两步：
   * 1. 语言检测 — 非英文则中断并提示
   * 2. 六维分析 — 流式返回，完成后异步触发知识图谱生成
   */
  async function handleAnalyze() {
    if (!input.trim()) return;

    // 取消进行中的朗读
    readAloudAbortRef.current?.abort();
    setReadAloudActive(false);
    setCurrentSentenceIndex(-1);

    // 取消上一次的语言检测和图谱请求
    detectAbortRef.current?.abort();
    graphAbortRef.current?.abort();

    // 取消上一次未完成的请求（hook 内部也会 abort，这里提前清理 UI 状态）
    abort();

    const model = await getDefaultModel();
    if (!model?.api_key) {
      setError("请先在设置页面配置 LLM 模型。");
      return;
    }

    // === 第一步：语言检测（使用独立 AbortController，支持取消） ===
    setDetecting(true);
    setError(null);
    setResult("");
    setGraphData(null);

    const detectController = new AbortController();
    detectAbortRef.current = detectController;
    let detectText = "";
    try {
      const detectMessages = buildPrompt(DETECT_PROMPT, input);
      await new Promise<void>((resolve, reject) => {
        streamChat(
          detectMessages,
          model,
          {
            onToken: (token) => { detectText += token; },
            onDone: () => resolve(),
            onError: (err) => reject(err),
          },
          detectController.signal
        );
      });
    } catch {
      setDetecting(false);
      setError("语言检测失败，请重试。");
      return;
    }

    // 解析语言检测结果
    const detected = extractJson<{ isEnglish: boolean; reason?: string }>(detectText);
    if (detected && !detected.isEnglish) {
      setDetecting(false);
      setError(`Reading Copilot 仅支持英文输入。${detected.reason || ""}`);
      return;
    }

    setDetecting(false);

    // === 第二步：六维精读分析（通过 hook 管理 loading/task 状态） ===
    await execute(READING_PROMPT, input, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: async (fullText) => {
        const historyId = await addHistorySafe({
          type: "reading",
          input_text: input,
          result: fullText,
        });
        // 第三步：异步生成知识图谱（不阻塞 UI，支持取消）
        const graphController = new AbortController();
        graphAbortRef.current = graphController;
        fetchGraphData(input, historyId ?? undefined, graphController.signal);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  }

  /**
   * 原文中单词的点击处理器。
   * 清理非字母字符后，将单词设为 selectedWord，触发"添加到生词本"UI。
   * 使用 useCallback 避免每次渲染重新创建（传给 input.split().map 的 onClick）。
   */
  const handleWordClick = useCallback((word: string) => {
    // 只保留字母、连字符、撇号（如 well-known、it's）
    const cleaned = word.replace(/[^a-zA-Z'-]/g, "");
    if (cleaned.length > 1) {
      setSelectedWord(cleaned);
    }
  }, []);

  /**
   * 将选中的单词快速添加到生词本。
   * 先调用 enrichWord 补全词汇数据（音标、释义、搭配、例句），
   * 失败时回退到默认值（null 音标、"待补充"释义）。
   * 添加后清除 selectedWord，隐藏操作按钮。
   */
  /** 已添加到生词本的单词集合，防止重复添加 */
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());

  async function handleAddToVocabulary() {
    if (!selectedWord || addedWords.has(selectedWord)) return;

    setEnriching(true);
    let phonetic: string | null = null;
    let definition = "待补充";
    let notes: string | null = null;

    try {
      const enriched = await enrichWord(selectedWord);
      if (enriched) {
        phonetic = enriched.phonetic || null;
        definition = enriched.definition || "待补充";
        notes = [
          enriched.collocations && `搭配: ${enriched.collocations}`,
          enriched.example && `例句: ${enriched.example}`,
        ]
          .filter(Boolean)
          .join("\n") || null;
      }
    } catch {
      // enrichment 失败，使用默认值
    }

    try {
      await addWord({
        word: selectedWord,
        phonetic,
        definition,
        level: null,
        source_type: "reading",
        source_text: input.substring(0, 200),
        notes,
        review_status: "new",
      });
      setAddedWords((prev) => new Set(prev).add(selectedWord));
      setSelectedWord(null);
    } catch (e) {
      console.warn("Failed to add word:", e);
    } finally {
      setEnriching(false);
    }
  }

  /**
   * 将 LLM 返回的 markdown 按 ## 标题拆分为各维度的内容。
   * useMemo 避免每次渲染都重新解析。
   */
  const sections = useMemo(() => parseSections(result), [result]);
  /** 是否有任何维度有内容（用于判断是否显示降级的原始内容） */
  const hasSections = Object.values(sections).some((v) => v.length > 0);

  /** 只渲染有内容的维度（LLM 可能未输出所有维度） */
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

      {/* 错误提示 */}
      {error && <ErrorBanner message={error} />}

      {/* 语言检测中... */}
      {detecting && <LoadingIndicator text="正在检测语言..." />}

      {/* 原文展示区 — 支持单词点击选中 + 快速添加到生词本 + 朗读 */}
      {result && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            <span className="font-semibold text-green-700 dark:text-green-300">Original</span>
            <Button
              size="sm"
              variant={readAloudActive ? "secondary" : "outline"}
              className="ml-auto"
              onClick={readAloudActive ? handleStopReadAloud : handleReadAloud}
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
          {/* 按句子分组，逐词可点击；朗读时当前句子高亮 */}
          <div className="text-sm leading-relaxed">
            {splitSentences(input).map((sentence, sentIdx) => (
              <span
                key={sentIdx}
                className={sentIdx === currentSentenceIndex ? "bg-yellow-200/50 dark:bg-yellow-500/20 rounded" : ""}
              >
                {sentence.split(/(\s+)/).map((word, wordIdx) => (
                  <span
                    key={`${sentIdx}-${wordIdx}`}
                    className="hover:bg-primary/10 hover:rounded px-0.5 cursor-pointer"
                    onClick={() => handleWordClick(word)}
                  >
                    {word}
                  </span>
                ))}
                {" "}
              </span>
            ))}
          </div>
          {/* 选中单词后显示操作栏 */}
          {selectedWord && (
            <div className="flex items-center justify-between pt-3 border-t border-green-500/20">
              <span className="text-sm font-medium">
                选中：{selectedWord}
              </span>
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

      {/* 空状态引导 */}
      {!result && !loading && !detecting && !error && (
        <EmptyState
          icon={BookOpen}
          title="粘贴英文文章，开始深度精读"
          subtitle="提供翻译、词汇、句式、语法、背景、思考六个维度分析"
        />
      )}

      {/* 第一个维度到达前的加载占位 */}
      {loading && !sections["参考翻译"] && (
        <LoadingIndicator text="正在分析..." className="h-24" />
      )}

      {/* 六维分析结果 — 每个维度一个可折叠的 ResultCard */}
      {visibleSections.map((sec) => (
            <ResultCard
              key={sec.key}
              title={sec.title}
              icon={sec.icon}
              collapsible
            >
              {/* 重点词汇维度使用专用的 VocabularySection 组件（支持添加到生词本），其余用 ReactMarkdown */}
              {sec.key === "重点词汇" ? (
                <VocabularySection content={sections[sec.key]} sourceText={input} />
              ) : (
                <ReactMarkdown>{sections[sec.key]}</ReactMarkdown>
              )}
            </ResultCard>
          )
      )}

      {/* 降级：有结果但未能按 ## 标题拆分时，直接渲染原始 markdown */}
      {result && !loading && !hasSections && (
        <ResultCard
          title="分析结果"
          icon={<BookOpen className="h-4 w-4" />}
          collapsible
        >
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{result}</ReactMarkdown>
          </div>
        </ResultCard>
      )}

      {/* 知识图谱 — 由 fetchGraphData 异步生成，默认折叠以减少视觉干扰 */}
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
