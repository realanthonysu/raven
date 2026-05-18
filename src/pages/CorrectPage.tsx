import { useState } from "react";
import { TextInput } from "@/components/TextInput";
import { ResultCard } from "@/components/ResultCard";
import { streamChat, buildPrompt, parseSections } from "@/services/llm";
import { BookCheck, BookOpen, Globe, Search, ClipboardCheck } from "lucide-react";
import ReactMarkdown from "react-markdown";

const CORRECT_PROMPT = `你是一个专业的英语纠错和学习助手。用户会输入一段英文文本，你需要提供全面的纠正分析报告。

请按以下 5 个部分输出，严格使用 markdown 格式：

## 语法纠正
找出所有语法错误，每个错误用以下格式：
- 原文：[错误部分用删除线标注]
- 修正：[正确部分]
- 规则：[语法规则说明]

如果无语法错误，写"未发现语法错误。"

## 词汇纠正
找出用词不当的地方：
- 原词 → 建议替换词
- 语境适配说明

如果无词汇问题，写"词汇使用恰当。"

## 地道表达纠正
找出中式英语或不地道的表达：
- 原表达 → 地道表达
- 文化语境说明

如果表达地道，写"表达地道，无需调整。"

## 句型分析
选择文中结构最复杂的一个句子：
- 标注主干和修饰成分
- 说明句型结构
- 如果是长难句，拆解从句层次

## 纠正总结
- 问题统计（语法/词汇/表达各几处）
- 共性问题归纳
- 针对性的学习建议`;

export default function CorrectPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCorrect() {
    if (!input.trim()) return;

    let model = null;
    try {
      const raw = localStorage.getItem("raven-models");
      if (raw) {
        const models = JSON.parse(raw);
        model = models.find((m: any) => m.is_default) ?? models[0];
      }
    } catch {}

    if (!model?.api_key) {
      setResult("错误：请先在设置页面配置 LLM 模型。");
      return;
    }

    setLoading(true);
    setResult("");

    const messages = buildPrompt(CORRECT_PROMPT, input);

    await streamChat(messages, model, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: () => setLoading(false),
      onError: (error) => {
        setLoading(false);
        setResult(`错误：${error.message}`);
      },
    });
  }

  const sections = parseSections(result);

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">纠正</h2>

      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleCorrect}
        placeholder="输入英文文本..."
        loading={loading}
        submitLabel="开始纠正"
      />

      {result && (
        <div className="space-y-4">
          {sections["语法纠正"] && (
            <ResultCard title="语法纠正" icon={<BookCheck className="h-4 w-4" />}>
              <ReactMarkdown>{sections["语法纠正"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["词汇纠正"] && (
            <ResultCard title="词汇纠正" icon={<BookOpen className="h-4 w-4" />}>
              <ReactMarkdown>{sections["词汇纠正"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["地道表达纠正"] && (
            <ResultCard title="地道表达纠正" icon={<Globe className="h-4 w-4" />}>
              <ReactMarkdown>{sections["地道表达纠正"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["句型分析"] && (
            <ResultCard title="句型分析" icon={<Search className="h-4 w-4" />}>
              <ReactMarkdown>{sections["句型分析"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["纠正总结"] && (
            <ResultCard title="纠正总结" icon={<ClipboardCheck className="h-4 w-4" />} variant="success">
              <ReactMarkdown>{sections["纠正总结"]}</ReactMarkdown>
            </ResultCard>
          )}
        </div>
      )}
    </div>
  );
}
