import { useState } from "react";
import { TextInput } from "@/components/TextInput";
import { ResultCard } from "@/components/ResultCard";
import { streamChat, buildPrompt, parseSections } from "@/services/llm";
import { getDefaultModel } from "@/lib/model-storage";
import { addHistory } from "@/lib/history-storage";
import { Languages, BookOpen, Lightbulb, Search } from "lucide-react";
import ReactMarkdown from "react-markdown";

const TRANSLATE_PROMPT = `你是一个专业的翻译和英语学习助手。用户会输入一段文本（中文或英文），你需要：

1. **翻译结果**：给出最佳翻译。自动识别输入语言，中译英或英译中。

2. **用词分析**：挑选翻译中的关键短语（3-5个），每个包含：
   - 原文 + 对应翻译
   - 如果是固定搭配：讲解搭配结构，给出同类替换词（标注 📌 固定搭配）
   - 如果与直译差异大：说明为何需要转化（标注 🌍 地道表述）
   - 如果涉及专业领域：补充背景知识和标准译法（标注 🏷️ 行业术语）
   - 三种标注可叠加

3. **句子结构拆解**：选择一个最复杂的句子，标注主干和修饰成分，说明句型结构。

4. **翻译技巧提示**：列出本次翻译用到的 2-4 个翻译技巧（如语序调整、隐喻转化、关联词转换等）。

请严格按以下格式输出（使用 markdown）：

## 翻译结果
[翻译文本]

## 用词分析
[每个短语的分析，包含对应标注]

## 句子结构拆解
[句子分析]

## 翻译技巧提示
[技巧列表]`;

export default function TranslatePage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleTranslate() {
    if (!input.trim()) return;

    const model = getDefaultModel();
    if (!model || !model.api_key) {
      setResult("错误：请先在设置页面配置 LLM 模型。");
      return;
    }

    setLoading(true);
    setResult("");

    const messages = buildPrompt(TRANSLATE_PROMPT, input);

    await streamChat(messages, model, {
      onToken: (token) => setResult((prev) => prev + token),
      onDone: (fullText) => {
        setLoading(false);
        addHistory({ type: "translate", input_text: input, result: fullText });
      },
      onError: (error) => {
        setLoading(false);
        setResult(`错误：${error.message}`);
      },
    });
  }

  const sections = parseSections(result);

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">翻译</h2>

      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleTranslate}
        placeholder="输入中文或英文文本..."
        loading={loading}
        submitLabel="翻译"
      />

      {result && (
        <div className="space-y-4">
          {sections["翻译结果"] && (
            <ResultCard title="翻译结果" icon={<Languages className="h-4 w-4" />}>
              <ReactMarkdown>{sections["翻译结果"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["用词分析"] && (
            <ResultCard title="用词分析" icon={<BookOpen className="h-4 w-4" />}>
              <ReactMarkdown>{sections["用词分析"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["句子结构拆解"] && (
            <ResultCard title="句子结构拆解" icon={<Search className="h-4 w-4" />}>
              <ReactMarkdown>{sections["句子结构拆解"]}</ReactMarkdown>
            </ResultCard>
          )}
          {sections["翻译技巧提示"] && (
            <ResultCard title="翻译技巧提示" icon={<Lightbulb className="h-4 w-4" />} variant="highlight">
              <ReactMarkdown>{sections["翻译技巧提示"]}</ReactMarkdown>
            </ResultCard>
          )}
        </div>
      )}
    </div>
  );
}
