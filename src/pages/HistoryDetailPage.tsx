import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Copy,
  Dumbbell,
  Headphones,
  Lightbulb,
  Network,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams } from "react-router-dom";
import { ExerciseCard } from "@/components/ExerciseCard";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import { ResultCard } from "@/components/ResultCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getHistoryById } from "@/lib/db";
import { extractJson, matchAnswer, parseCorrectionJson, parseSections } from "@/lib/parse-utils";
import { readingSectionConfig, typeConfig } from "@/lib/type-config";
import type { ExerciseResult, HistoryRecord, ListeningResult } from "@/types";

/**
 * 写作纠错记录的详情展示子组件。
 * 复用 CorrectPage 的结果展示逻辑，但从数据库读取已持久化的数据。
 *
 * 渲染结构：
 * 1. 纠正后的完整文本（绿色区块 + 复制按钮）
 * 2. 逐条纠错详情（原文→纠正、类别标签、解释）
 * 3. 写作建议总结（黄色区块）
 *
 * 降级：JSON 解析失败时直接显示原始文本。
 */
function WritingDetail({ record }: { record: HistoryRecord }) {
  const parsed = parseCorrectionJson(record.result);

  // JSON 解析失败的降级处理
  if (!parsed) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  return (
    <div className="space-y-5">
      {/* 纠正后的完整文本 */}
      <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-5">
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
          <span className="font-semibold text-green-700 dark:text-green-300">Corrected</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            onClick={() => navigator.clipboard.writeText(parsed.corrected_text)}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{parsed.corrected_text}</p>
      </div>

      {/* 逐条纠错详情 */}
      {parsed.corrections.length > 0 && (
        <div className="space-y-4">
          <h3 className="flex items-center gap-2 font-semibold text-sm">
            <ClipboardList className="h-4 w-4" />
            Corrections
          </h3>
          {parsed.corrections.map((c) => (
            <div
              key={c.original}
              className="rounded-lg border border-border/60 bg-card p-4 space-y-2"
            >
              <div className="text-sm">
                <span className="line-through text-red-500/80">{c.original}</span>
                <span className="mx-2 text-muted-foreground">&rarr;</span>
                <span className="font-semibold text-green-600 dark:text-green-400">
                  {c.corrected}
                </span>
              </div>
              <span className="inline-block rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs px-2.5 py-0.5 font-medium">
                {c.category}
              </span>
              <p className="text-sm text-muted-foreground leading-relaxed">{c.explanation}</p>
            </div>
          ))}
        </div>
      )}

      {/* 写作建议总结 */}
      {parsed.summary && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 flex gap-3">
          <Lightbulb className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
          <p className="text-sm leading-relaxed text-muted-foreground">{parsed.summary}</p>
        </div>
      )}
    </div>
  );
}

/**
 * 阅读精读记录的详情展示子组件。
 * 从持久化的 result 字段中按 ## 标题拆分各分析维度，逐个渲染为 ResultCard。
 * 如果记录包含 graph_data（知识图谱 JSON），也会渲染 KnowledgeGraph。
 *
 * 降级：无法拆分 sections 时直接渲染原始 markdown。
 */
function ReadingDetail({ record }: { record: HistoryRecord }) {
  const sections = parseSections(record.result);

  // 无法拆分时降级渲染
  if (Object.keys(sections).length === 0) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{record.result}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 按 ## 标题逐个渲染分析维度 */}
      {Object.entries(sections).map(([title, content]) => {
        // readingSectionConfig 提供每个维度的标题和图标配置
        const config = readingSectionConfig[title];
        return (
          <ResultCard key={title} title={config?.title ?? title} icon={config?.icon} collapsible>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </ResultCard>
        );
      })}

      {/* 知识图谱（如果历史记录中包含 graph_data） */}
      {record.graph_data &&
        (() => {
          try {
            const parsed = JSON.parse(record.graph_data);
            return (
              <ResultCard
                title="🕸️ 知识图谱"
                icon={<Network className="h-4 w-4" />}
                variant="highlight"
                collapsible
                defaultExpanded={false}
              >
                <KnowledgeGraph data={parsed} />
              </ResultCard>
            );
          } catch {
            // graph_data JSON 解析失败时静默跳过
            return null;
          }
        })()}
    </div>
  );
}

/**
 * 弱项训练记录的详情展示子组件（只读回顾模式）。
 *
 * 数据来源：history 表中 type="exercise" 的记录，result 字段为 ExerciseResult JSON。
 * 使用共享的 ExerciseCard 组件以只读模式渲染每道题。
 *
 * 渲染结构：
 * 1. 得分概览卡片（橙色主题，显示类别 + 得分/总题数）
 * 2. 逐题回顾卡片（由 ExerciseCard 渲染，只读模式）
 */
function ExerciseDetail({ record }: { record: HistoryRecord }) {
  // 使用 extractJson 解析持久化的 ExerciseResult JSON，失败时降级为纯文本展示
  const data = extractJson<ExerciseResult>(record.result);

  if (!data) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  // 用 const 别名固定引用，让 TypeScript 能在 .map() 闭包内正确窄化类型
  const result = data;

  return (
    <div className="space-y-5">
      {/* 得分概览：橙色主题卡片，与 ExercisePage 的 exercise 类型配色一致 */}
      <div className="rounded-lg border border-orange-500/40 bg-orange-500/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <Dumbbell className="h-5 w-5 text-orange-600 dark:text-orange-400" />
          <span className="font-semibold text-orange-700 dark:text-orange-300">
            训练类别：{result.category}
          </span>
        </div>
        <p className="text-2xl font-bold">
          {result.score}/{result.exercises.length}
          <span className="text-sm font-normal text-muted-foreground ml-2">正确</span>
        </p>
      </div>

      {/* 逐题回顾：使用共享 ExerciseCard 组件，只读模式（无 onAnswer） */}
      {result.exercises.map((ex, i) => (
        <ExerciseCard
          key={ex.question.slice(0, 50)}
          index={i}
          exercise={ex}
          userAnswer={result.userAnswers[i]?.trim() ?? ""}
          showResult={true}
        />
      ))}
    </div>
  );
}

/**
 * 听力练习记录的详情展示子组件。
 *
 * 数据来源：history 表中 type="listening" 的记录，result 字段为 ListeningResult JSON。
 *
 * 渲染结构：
 * 1. 得分概览卡片（青色主题，显示话题 + 难度 + 得分/总句数）
 * 2. 逐句对比（原文 vs 用户听写结果 + 正确/错误标记）
 *
 * 降级：JSON 解析失败时直接显示原始文本。
 */
function ListeningDetail({ record }: { record: HistoryRecord }) {
  const data = extractJson<ListeningResult>(record.result);

  if (!data) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  const result = data;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <Headphones className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          <span className="font-semibold text-cyan-700 dark:text-cyan-300">
            听力练习：{result.topic} ({result.difficulty})
          </span>
        </div>
        <p className="text-2xl font-bold">
          {result.score}/{result.sentences.length}
          <span className="text-sm font-normal text-muted-foreground ml-2">正确</span>
        </p>
      </div>

      {result.sentences.map((s, i) => {
        const userInput = result.userInputs[i]?.trim() ?? "";
        const correct = matchAnswer(userInput, s.text, "rewrite");
        return (
          <div
            key={s.text.slice(0, 50)}
            className={`rounded-lg border p-5 space-y-3 ${
              correct ? "border-green-500/40 bg-green-500/5" : "border-red-500/40 bg-red-500/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">第 {i + 1} 句</span>
              {correct ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              )}
            </div>
            <p className="text-sm font-medium text-green-700 dark:text-green-300">{s.text}</p>
            {!correct && (
              <p className="text-sm">
                <span className="text-muted-foreground">你的回答：</span>
                <span className="text-red-600 dark:text-red-400">{userInput || "(未作答)"}</span>
              </p>
            )}
            <p className="text-xs text-muted-foreground italic">{s.hint}</p>
          </div>
        );
      })}
    </div>
  );
}

/** 记录类型 → 详情组件的映射表，替代原先的多层三元表达式 */
const DETAIL_COMPONENTS: Record<string, React.FC<{ record: HistoryRecord }>> = {
  reading: ReadingDetail,
  exercise: ExerciseDetail,
  listening: ListeningDetail,
  correct: WritingDetail,
};

/**
 * 历史详情页面。
 *
 * 根据 URL 参数中的 id 从数据库加载单条历史记录，
 * 根据记录类型（correct / reading）分别渲染 WritingDetail 或 ReadingDetail。
 *
 * 路由：/history/:id
 * 数据流：useParams 获取 id → useEffect 加载记录 → 条件渲染子组件
 */
export default function HistoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<HistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);

  /** 根据 id 加载历史记录 */
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getHistoryById(Number(id))
      .then(setRecord)
      .finally(() => setLoading(false));
  }, [id]);

  // 加载中状态
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  // 记录不存在（id 无效或已被删除）
  if (!record) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </Button>
        <p className="text-muted-foreground text-center py-12">记录不存在。</p>
      </div>
    );
  }

  const config = typeConfig[record.type as keyof typeof typeConfig];
  const Icon = config?.icon ?? BookOpen;

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* 顶部导航栏：返回按钮 + 类型标签 + 时间 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </Button>
        {config && (
          <Badge variant="secondary" className={config.color}>
            <Icon className="h-3 w-3 mr-1" />
            {config.label}
          </Badge>
        )}
        <span className="text-sm text-muted-foreground">
          {new Date(record.created_at).toLocaleString("zh-CN")}
        </span>
      </div>

      {/* 用户输入的原文 */}
      <div className="rounded-lg border p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          原文
        </h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{record.input_text}</p>
      </div>

      {/* 根据记录类型渲染不同的详情子组件 */}
      {(() => {
        const Detail = DETAIL_COMPONENTS[record.type] ?? WritingDetail;
        return <Detail record={record} />;
      })()}
    </div>
  );
}
