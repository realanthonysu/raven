import { Check, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { addWord } from "@/lib/db";
import { buildEnrichmentNotes } from "@/lib/word-utils";

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
 * 解析策略（逐行扫描）：
 * 1. 逐行扫描，找到 **粗体** 标记作为新词汇的起点
 * 2. 用 SECTION_LABELS 过滤掉中文小标题，避免被误识别为词汇条目
 * 3. 每个词汇收集其后的所有行，直到遇到下一个粗体词汇标记
 * 4. 从收集的行中提取音标、释义、搭配、例句
 * 5. 按单词去重合并
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

  // 用于判断一行是否包含新的粗体词汇标记（非小标题）
  const boldWordRe = /\*\*(.+?)\*\*/;

  const lines = markdown.split("\n");
  // 收集每个词汇的文本行：{ word, lines }
  const groups: { word: string; lines: string[] }[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const boldMatch = line.match(boldWordRe);
    if (boldMatch) {
      const word = boldMatch[1].trim();
      // 判断是否为真正的词汇标题：
      // 1. 同行有音标（/.../ 或 [...]），或
      // 2. 下一行是音标行（且不是标签行）
      const phoneticRe = /[/[/（(][^/\]）)\n]+[/\]）)]/;
      const sameLinePhonetic = phoneticRe.test(line);
      const nextLine = li + 1 < lines.length ? lines[li + 1] : "";
      const nextLineIsPhonetic =
        phoneticRe.test(nextLine) && !/(?:释义|搭配|例句|举例|定义)[：:]/.test(nextLine);
      if (
        word.length > 0 &&
        word.length < 50 &&
        !word.includes("\n") &&
        !SECTION_LABELS.has(word) &&
        (sameLinePhonetic || nextLineIsPhonetic)
      ) {
        groups.push({ word, lines: [line] });
        continue;
      }
    }
    // 非词汇行，追加到当前最后一个 group
    if (groups.length > 0) {
      groups[groups.length - 1].lines.push(line);
    }
  }

  // 从每个 group 的文本行中提取结构化字段
  for (const group of groups) {
    const text = group.lines.join("\n");

    // 提取音标：支持 /.../、[...]、（...）、(...) 等格式
    // 音标特征：被 / 或 [] 包裹，内容包含英文字母（排除中文释义）
    const phoneticMatch = text.match(/[/[/（(]([^/\]）)\n]+)[/\]）)]/);
    const phonetic =
      phoneticMatch && /[a-zA-Z]/.test(phoneticMatch[1]) ? phoneticMatch[1].trim() : "";

    // 提取释义、搭配、例句（匹配各种中文标签变体）
    const definitionMatch = text.match(/(?:文中释义|释义|定义|中文释义)[：:]\s*(.+)/);
    const collocationsMatch = text.match(/(?:常见搭配|搭配|固定搭配)[：:]\s*(.+)/);
    const exampleMatch = text.match(/(?:例句|举例)[：:]\s*(.+)/);

    // 如果没有标签释义，尝试提取 / 包裹的非音标文本作为释义
    let definition = definitionMatch?.[1]?.trim() ?? "";
    if (!definition && !phonetic) {
      const slashContent = text.match(/[/]([^/\n]+)[/]/);
      if (slashContent && !/[a-zA-Z]/.test(slashContent[1])) {
        definition = slashContent[1].trim();
      }
    }

    // 降级：如果仍无释义，提取音标行之后的第一个中文文本行作为释义
    if (!definition && phonetic) {
      const phoneticLineIdx = group.lines.findIndex(
        (l) => l.includes(`/${phonetic}/`) || l.includes(`[${phonetic}]`),
      );
      if (phoneticLineIdx >= 0) {
        for (let j = phoneticLineIdx + 1; j < group.lines.length; j++) {
          const nextLine = group.lines[j].replace(/^[-•]\s*/, "").trim();
          // 跳过空行、英文行、标签行（含"释义："等），找第一个中文文本
          if (
            nextLine &&
            /[一-鿿]/.test(nextLine) &&
            !/(?:释义|搭配|例句|举例|定义)[：:]/.test(nextLine)
          ) {
            definition = nextLine;
            break;
          }
        }
      }
    }

    // 至少要有释义或音标才认为是有效条目
    if (definitionMatch || phonetic || definition) {
      entries.push({
        word: group.word,
        phonetic,
        definition,
        collocations: collocationsMatch?.[1]?.trim() ?? "",
        example: exampleMatch?.[1]?.trim() ?? "",
      });
    }
  }

  // 按单词去重：同一单词合并各字段中非空的值
  const seen = new Map<string, VocabEntry>();
  for (const entry of entries) {
    const key = entry.word.toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entry);
    } else {
      seen.set(key, {
        word: existing.word,
        phonetic: existing.phonetic || entry.phonetic,
        definition: existing.definition || entry.definition,
        collocations: existing.collocations || entry.collocations,
        example: existing.example || entry.example,
      });
    }
  }
  return [...seen.values()];
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
        notes: buildEnrichmentNotes(entry),
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
