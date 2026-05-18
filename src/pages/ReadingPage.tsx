import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ResultCard } from "@/components/ResultCard";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import { streamChat, buildPrompt, parseSections } from "@/services/llm";
import { getDefaultModel, addHistory, addWord } from "@/lib/db";
import { BookOpen, Search, Globe, Network, Loader2, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";

const READING_PROMPT = `你是一个专业的英语精读助手。用户会输入一段英文文章，你需要提供深度的精读分析。

请按以下格式输出，严格使用 markdown：

## 词汇解析
挑选文章中的关键词汇（5-10个），每个包含：
- 单词 + 音标
- 文中释义
- 常见搭配
- 例句

## 句法分析
选择 2-3 个结构复杂的句子：
- 标注句子成分（主语、谓语、宾语、定语、状语等）
- 说明从句类型和作用
- 提供中文翻译

## 文化背景
解释文章中涉及的文化背景知识（如有）：
- 专有名词解释
- 历史/文化背景
- 相关知识延伸

## 核心概念
列出文章的 3-5 个核心概念，每个包含：
- 概念名称
- 概念解释
- 与其他概念的关系`;

const GRAPH_DATA_PROMPT = `分析以下英文文本，提取其中的核心概念和它们之间的关系，输出为 JSON 格式。

输出格式（严格 JSON，不要包含其他内容）：
{
  "nodes": [
    { "id": "concept1", "label": "概念名称", "type": "word|concept|entity" }
  ],
  "edges": [
    { "source": "concept1", "target": "concept2", "relation": "关系描述" }
  ]
}

关系类型包括：同义、反义、搭配、上下位、因果、对比、包含等。
提取 5-15 个节点，10-30 条边。只输出 JSON，不要其他内容。`;

export default function ReadingPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<{
    nodes: { id: string; label: string; type: string }[];
    edges: { source: string; target: string; relation: string }[];
  } | null>(null);

  async function fetchGraphData(text: string) {
    const model = await getDefaultModel();
    if (!model?.api_key) return;

    const messages = buildPrompt(GRAPH_DATA_PROMPT, text);
    let graphText = "";
    await streamChat(messages, model, {
      onToken: (token) => {
        graphText += token;
      },
      onDone: (fullText) => {
        try {
          const parsed = JSON.parse(fullText);
          setGraphData(parsed);
        } catch {
          // Ignore parse errors
        }
      },
      onError: () => {},
    });
  }

  async function handleAnalyze() {
    if (!input.trim()) return;

    const model = await getDefaultModel();
    if (!model?.api_key) {
      setResult("错误：请先在设置页面配置 LLM 模型。");
      return;
    }

    setLoading(true);
    setResult("");
    setGraphData(null);

    const messages = buildPrompt(READING_PROMPT, input);

    await streamChat(messages, model, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: (fullText) => {
        setLoading(false);
        addHistory({ type: "reading", input_text: input, result: fullText });
        fetchGraphData(input);
      },
      onError: (error) => {
        setLoading(false);
        setResult(`错误：${error.message}`);
      },
    });
  }

  function handleWordClick(word: string) {
    const cleaned = word.replace(/[^a-zA-Z'-]/g, "");
    if (cleaned.length > 1) {
      setSelectedWord(cleaned);
    }
  }

  async function handleAddToVocabulary() {
    if (selectedWord) {
      await addWord({
        word: selectedWord,
        phonetic: null,
        definition: "待补充",
        level: null,
        source_type: "reading",
        source_text: input.substring(0, 200),
        notes: null,
        review_status: "new",
      });
      setSelectedWord(null);
    }
  }

  const sections = parseSections(result);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-2xl font-bold">精读</h2>
        <Button onClick={handleAnalyze} disabled={loading || !input.trim()}>
          {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          开始精读
        </Button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Original text */}
        <div className="w-1/2 border-r flex flex-col">
          <div className="p-4 border-b">
            <h3 className="text-sm font-medium text-muted-foreground">原文</h3>
          </div>
          <div className="flex-1 p-4 overflow-auto">
            {result ? (
              <div className="text-sm leading-relaxed">
                {input.split(/(\s+)/).map((word, i) => (
                  <span
                    key={i}
                    className="hover:bg-primary/10 hover:rounded px-0.5 cursor-pointer"
                    onClick={() => handleWordClick(word)}
                  >
                    {word}
                  </span>
                ))}
              </div>
            ) : (
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="粘贴英文文章..."
                className="h-full resize-none border-0 p-0 focus-visible:ring-0"
              />
            )}
          </div>

          {selectedWord && (
            <div className="p-3 border-t bg-muted/50 flex items-center justify-between">
              <span className="text-sm font-medium">选中：{selectedWord}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddToVocabulary}
              >
                <Plus className="h-3 w-3 mr-1" />
                添加到生词本
              </Button>
            </div>
          )}
        </div>

        {/* Right: Analysis results */}
        <div className="w-1/2 flex flex-col">
          <div className="p-4 border-b">
            <h3 className="text-sm font-medium text-muted-foreground">
              分析结果
            </h3>
          </div>
          <div className="flex-1 p-4 overflow-auto space-y-4">
            {loading && !result && (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                正在分析...
              </div>
            )}
            {sections["词汇解析"] && (
              <ResultCard
                title="词汇解析"
                icon={<BookOpen className="h-4 w-4" />}
              >
                <ReactMarkdown>{sections["词汇解析"]}</ReactMarkdown>
              </ResultCard>
            )}
            {sections["句法分析"] && (
              <ResultCard
                title="句法分析"
                icon={<Search className="h-4 w-4" />}
              >
                <ReactMarkdown>{sections["句法分析"]}</ReactMarkdown>
              </ResultCard>
            )}
            {sections["文化背景"] && (
              <ResultCard
                title="文化背景"
                icon={<Globe className="h-4 w-4" />}
              >
                <ReactMarkdown>{sections["文化背景"]}</ReactMarkdown>
              </ResultCard>
            )}
            {sections["核心概念"] && (
              <ResultCard
                title="核心概念"
                icon={<Network className="h-4 w-4" />}
                variant="highlight"
              >
                <ReactMarkdown>{sections["核心概念"]}</ReactMarkdown>
              </ResultCard>
            )}
            {graphData && (
              <ResultCard
                title="知识图谱"
                icon={<Network className="h-4 w-4" />}
                variant="highlight"
              >
                <KnowledgeGraph data={graphData} />
              </ResultCard>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
