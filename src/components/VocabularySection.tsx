import { Check, Loader2, Plus } from "lucide-react";
import { useMemo } from "react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { Button } from "@/components/ui/button";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { parseVocabularyEntries, type VocabEntry } from "@/lib/vocabulary-parser";

/**
 * VocabularySection 组件的 Props 接口
 */
interface VocabularySectionProps {
  /** LLM 返回的"重点词汇"部分的 markdown 文本 */
  content: string;
  /** 用户输入的原文（前 200 字符会作为 source_text 存入生词本） */
  sourceText: string;
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
 */
export function VocabularySection({ content, sourceText }: VocabularySectionProps) {
  const entries = useMemo(() => parseVocabularyEntries(content), [content]);
  // 复用共享 hook：added/adding 状态与 words 表写入统一管理，
  // 词条数据已在页面上（LLM 阅读输出），经 known 参数传入跳过重复的 LLM 补全
  const { addedWords, addingWords, addToVocabulary } = useAddToVocabulary();

  /** 将单个词汇条目写入生词本（notes 拼接搭配和例句，供复习页面展示） */
  function handleAdd(entry: VocabEntry) {
    void addToVocabulary(entry.word, sourceText, "reading", undefined, {
      phonetic: entry.phonetic,
      definition: entry.definition,
      collocations: entry.collocations,
      example: entry.example,
    });
  }

  // 降级：解析失败时渲染原始 markdown
  if (entries.length === 0) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <MarkdownContent content={content} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => {
        const added = addedWords.has(entry.word);
        const adding = addingWords.has(entry.word);
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
                disabled={added || adding}
              >
                {added ? (
                  <>
                    <Check className="h-3 w-3" />
                    已添加
                  </>
                ) : adding ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    添加中...
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
