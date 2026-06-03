import { Check, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { addWord } from "@/lib/db";

/** 从 LLM 返回的 markdown 中解析出的单个词汇条目 */
export interface VocabEntry {
  word: string;
  phonetic: string;
  definition: string;
  collocations: string;
  example: string;
}

/**
 * 从 LLM 返回的 markdown 中解析"重点词汇"部分的结构化数据。
 *
 * 解析策略：
 * 1. 找到所有 **粗体** 标记（即 LLM 输出的单词标题）
 * 2. 用 SECTION_LABELS 过滤掉中文小标题（如"常见搭配"、"例句"等），
 *    避免被误识别为词汇条目——这是 LLM 输出不规范导致的常见问题
 * 3. 以每个粗体词为起点，取到下一个粗体词之间的文本作为该词的 chunk
 * 4. 用正则从 chunk 中提取音标、释义、搭配、例句
 *
 * 降级策略：如果解析结果为空（LLM 输出格式异常），VocabularySection 会回退到纯 markdown 渲染。
 */
function parseVocabularyEntries(markdown: string): VocabEntry[] {
  const entries: VocabEntry[] = [];

  // 中文小标题集合——这些不应该被当作词汇单词
  const SECTION_LABELS = new Set([
    "常见搭配",
    "搭配",
    "固定搭配",
    "文中释义",
    "释义",
    "定义",
    "中文释义",
    "例句",
    "举例",
    "音标",
    "词性",
    "近义词",
    "反义词",
    "同根词",
  ]);

  // 策略：找到每个 **word** 粗体标记，收集其位置
  const wordPattern = /\*\*(.+?)\*\*/g;
  const matches: { word: string; index: number }[] = [];
  let m;
  while ((m = wordPattern.exec(markdown)) !== null) {
    const word = m[1].trim();
    // 过滤：长度异常、含换行、或是已知的中文小标题
    if (word.length > 0 && word.length < 50 && !word.includes("\n") && !SECTION_LABELS.has(word)) {
      matches.push({ word, index: m.index });
    }
  }

  // 以粗体词为边界，切割出每个词的文本块
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const chunk = markdown.slice(start, end);

    // 提取音标：支持 /.../、[...]、（...）、(...) 等格式
    const phoneticMatch = chunk.match(/[/[/（(]([^/\]）)\n]+)[/\]）)]/);
    const phonetic = phoneticMatch ? phoneticMatch[1].trim() : "";

    // 提取释义、搭配、例句（匹配各种中文标签变体）
    const definitionMatch = chunk.match(/(?:文中释义|释义|定义|中文释义)[：:]\s*(.+)/);
    const collocationsMatch = chunk.match(/(?:常见搭配|搭配|固定搭配)[：:]\s*(.+)/);
    const exampleMatch = chunk.match(/(?:例句|举例)[：:]\s*(.+)/);

    // 至少要有释义或音标才认为是有效条目
    if (definitionMatch || phonetic) {
      entries.push({
        word: matches[i].word,
        phonetic,
        definition: definitionMatch?.[1]?.trim() ?? "",
        collocations: collocationsMatch?.[1]?.trim() ?? "",
        example: exampleMatch?.[1]?.trim() ?? "",
      });
    }
  }

  return entries;
}

/**
 * 重点词汇展示子组件。
 *
 * 职责：
 * - 解析 LLM 返回的词汇 markdown 为结构化 VocabEntry[]
 * - 为每个词汇提供"添加到生词本"功能（写入 SQLite words 表）
 * - 已添加的词汇用 local state 标记，按钮变为"已添加"不可重复点击
 *
 * 降级：如果解析失败（entries 为空），回退为纯 ReactMarkdown 渲染。
 *
 * @param content - LLM 返回的"重点词汇"部分的 markdown 文本
 * @param sourceText - 用户输入的原文（前 200 字符会作为 source_text 存入生词本）
 */
export function VocabularySection({
  content,
  sourceText,
}: {
  content: string;
  sourceText: string;
}) {
  const entries = useMemo(() => parseVocabularyEntries(content), [content]);
  /** 记录本次会话中已添加的单词（用 Set 去重），避免重复写入 */
  const [addedWords, setAddedWords] = useState<Set<string>>(new Set());

  /**
   * 将单个词汇条目写入生词本。
   * notes 字段拼接搭配和例句，供复习页面展示。
   */
  async function handleAdd(entry: VocabEntry) {
    if (addedWords.has(entry.word)) return;
    try {
      await addWord({
        word: entry.word,
        phonetic: entry.phonetic || null,
        definition: entry.definition || "待补充",
        level: null,
        source_type: "reading",
        source_text: sourceText.substring(0, 200),
        notes:
          [
            entry.collocations && `搭配: ${entry.collocations}`,
            entry.example && `例句: ${entry.example}`,
          ]
            .filter(Boolean)
            .join("\n") || null,
        review_status: "new",
      });
      setAddedWords((prev) => new Set(prev).add(entry.word));
    } catch (e) {
      console.warn("Failed to add word:", e);
    }
  }

  // 降级：解析失败时渲染原始 markdown
  if (entries.length === 0) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => {
        const added = addedWords.has(entry.word);
        return (
          <div
            key={entry.word}
            className="rounded-lg border border-border/60 bg-card p-4 space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-base">{entry.word}</span>
                {entry.phonetic && (
                  <span className="text-sm text-muted-foreground">/{entry.phonetic}/</span>
                )}
              </div>
              <Button
                size="sm"
                variant={added ? "outline" : "default"}
                className="h-7 gap-1 text-xs"
                onClick={() => handleAdd(entry)}
                disabled={added}
              >
                {added ? (
                  <>
                    <Check className="h-3 w-3" />
                    已添加
                  </>
                ) : (
                  <>
                    <Plus className="h-3 w-3" />
                    添加到生词本
                  </>
                )}
              </Button>
            </div>
            {entry.definition && (
              <p className="text-sm text-muted-foreground">{entry.definition}</p>
            )}
            {entry.collocations && (
              <p className="text-sm">
                <span className="text-muted-foreground">搭配：</span>
                {entry.collocations}
              </p>
            )}
            {entry.example && (
              <p className="text-sm italic text-muted-foreground">{entry.example}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
