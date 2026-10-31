/**
 * @module HistoryDetailPage
 * @description 历史记录详情页面。
 *
 * 根据 URL 中的记录 ID 从数据库加载单条历史记录，
 * 根据记录类型（writing/reading/exercise/listening/speaking）分别渲染对应的详情子组件。
 *
 * 子组件映射：
 * - writing（含 legacy correct）→ WritingDetail：纠错报告展示
 * - reading → ReadingDetail：六维分析 + 知识图谱
 * - exercise → ExerciseDetail：练习题回顾
 * - listening → ListeningDetail：听写结果对比
 * - speaking → SpeakingDetail：口语评分回顾
 *
 * 路由：/history/:id
 */

import {
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Copy,
  Lightbulb,
  Loader2,
  Network,
  XCircle,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ExerciseCard } from "@/components/ExerciseCard";
import { LevelEstimateBadge } from "@/components/LevelEstimateBadge";
import { MarkdownContent } from "@/components/MarkdownContent";
import { ResultCard } from "@/components/ResultCard";
import { SpeakButton } from "@/components/SpeakButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getHistoryById, getHistoryGraphData, parseDbTimestamp } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  type ScoreOverviewContent,
  type ScoreOverviewTheme,
  scoreOverviews,
} from "@/lib/history-presentation";
import {
  extractJsonSafe,
  matchAnswerDetail,
  parseCorrectionJson,
  parseSections,
} from "@/lib/parse-utils";
import {
  ExerciseResultSchema,
  type GraphData,
  GraphDataSchema,
  ListeningResultSchema,
  SpeakingResultSchema,
} from "@/lib/schemas";
import { isHistoryType, readingSectionConfig, typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

/** BUG-04 修复：懒加载 KnowledgeGraph（Cytoscape.js ~200KB），避免增大主 bundle */
const KnowledgeGraph = lazy(() =>
  import("@/components/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph })),
);

/**
 * 得分概览卡 —— exercise/listening/speaking 三种详情共用的"得分总览"结构。
 * 此前三处卡片 JSX 仅强调色/图标/文案不同却各自复制一份；视觉主题
 * （色系/图标）现统一来自 history-presentation 注册表，文案由各 Detail
 * 从已解析的 result 数据经注册表的 content 构造。
 */
function ScoreOverviewCard({
  theme,
  content,
}: {
  theme: ScoreOverviewTheme;
  content: ScoreOverviewContent;
}) {
  const Icon = theme.icon;
  return (
    <div className={`rounded-lg border ${theme.containerClass} p-5`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`h-5 w-5 ${theme.iconClass}`} />
        <span className={`font-semibold ${theme.titleClass}`}>{content.title}</span>
      </div>
      <p className="text-2xl font-bold">
        {content.score}
        <span className="text-sm font-normal text-muted-foreground ml-2">{content.unit}</span>
      </p>
    </div>
  );
}

/**
 * 写作纠错记录的详情展示子组件。
 * 复用 CorrectPage 的结果展示逻辑，但从数据库读取已持久化的数据。
 *
 * 渲染结构：
 * 1. 写作水平估级徽章（Track 3 新增：仅当持久化结果含 level_estimate 时展示）
 * 2. 纠正后的完整文本（绿色区块 + 复制按钮）
 * 3. 逐条纠错详情（原文→纠正、类别标签、解释）
 * 4. 写作建议总结（黄色区块）
 *
 * 降级：JSON 解析失败时直接显示原始文本。
 */
function WritingDetail({ record }: { record: HistoryRecord }) {
  const parsed = useMemo(() => parseCorrectionJson(record.result), [record.result]);

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
          {parsed.corrections.map((c, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 同一原文可能重复出错,内容键会碰撞
              key={`${c.original}-${i}`}
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

      {/* 写作水平估级徽章（Track 3）：旧数据无 level_estimate 时组件渲染 nothing */}
      <LevelEstimateBadge estimate={parsed.level_estimate} />

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
 * 阅读详情的知识图谱区块（H-18）—— 用户点击后才拉取并解析 graph_data。
 *
 * 此前 ReadingDetail 一挂载就无条件 `getHistoryGraphData` + `extractJsonSafe`
 * （数十 KB JSON 跨 IPC + Zod 校验全部付掉，即使用户根本不展开图谱）。
 * 现在图谱卡片默认只展示入口按钮，点击后才发起查询；结构不符/无图谱时
 * 走既有的"无图谱"降级提示，不影响六维分析展示。
 *
 * 组件以 record.id 为 key 挂载：切换记录时状态自动复位，不会残留旧图谱。
 */
type GraphSectionState =
  | { status: "loading" }
  | { status: "ready"; data: GraphData }
  | { status: "empty" };

function LazyGraphContent({ recordId }: { recordId: number }) {
  const [requested, setRequested] = useState(false);
  const [state, setState] = useState<GraphSectionState>({ status: "loading" });

  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    setState({ status: "loading" });
    getHistoryGraphData(recordId)
      .then((raw) => {
        if (cancelled) return;
        const data = raw ? extractJsonSafe(raw, GraphDataSchema) : null;
        setState(data ? { status: "ready", data } : { status: "empty" });
      })
      .catch(() => {
        /* 图谱缺失不影响六维分析展示 */
        if (!cancelled) setState({ status: "empty" });
      });
    return () => {
      cancelled = true;
    };
  }, [requested, recordId]);

  if (!requested) {
    return (
      <Button variant="outline" size="sm" onClick={() => setRequested(true)}>
        <Network className="h-3.5 w-3.5 mr-1.5" />
        加载知识图谱
      </Button>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state.status === "empty") {
    return <p className="text-sm text-muted-foreground py-6 text-center">该记录未保存知识图谱。</p>;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-[400px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <KnowledgeGraph data={state.data} />
    </Suspense>
  );
}

/**
 * 阅读精读记录的详情展示子组件。
 * 从持久化的 result 字段中按 ## 标题拆分各分析维度，逐个渲染为 ResultCard。
 * 知识图谱经 LazyGraphContent 按需拉取（H-18）。
 *
 * 降级：无法拆分 sections 时直接渲染原始 markdown。
 */
export function ReadingDetail({ record }: { record: HistoryRecord }) {
  const sections = useMemo(() => parseSections(record.result), [record.result]);

  // 无法拆分时降级渲染
  if (Object.keys(sections).length === 0) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <MarkdownContent content={record.result} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 按 ## 标题逐个渲染分析维度。默认仅展开首节（H-18）：其余节折叠后
          不挂载 MarkdownContent，避免一次挂载就解析全部 6 个维度 */}
      {Object.entries(sections).map(([title, content], index) => {
        // readingSectionConfig 提供每个维度的标题和图标配置
        const config = readingSectionConfig[title];
        return (
          <ResultCard
            key={title}
            title={config?.title ?? title}
            icon={config?.icon}
            collapsible
            defaultExpanded={index === 0}
          >
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownContent content={content} />
            </div>
          </ResultCard>
        );
      })}

      {/* 知识图谱：用户点击后才拉取/解析 graph_data */}
      <ResultCard title="🕸️ 知识图谱" icon={<Network className="h-4 w-4" />} variant="highlight">
        <LazyGraphContent key={record.id} recordId={record.id} />
      </ResultCard>
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
  // 经 extractJsonSafe + ExerciseResultSchema 校验解析持久化的 ExerciseResult JSON，
  // 结构不符（缺 exercises/userAnswers 等字段）时降级为纯文本展示而非崩溃
  const data = useMemo(() => extractJsonSafe(record.result, ExerciseResultSchema), [record.result]);

  if (!data) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  // 用 const 别名固定引用，让 TypeScript 能在 .map() 闭包内正确窄化类型
  const result = data;

  return (
    <div className="space-y-5">
      {/* 得分概览：橙色主题卡片，与 ExercisePage 的 exercise 类型配色一致（主题源自注册表） */}
      <ScoreOverviewCard
        theme={scoreOverviews.exercise.theme}
        content={scoreOverviews.exercise.content(result)}
      />

      {/* 逐题回顾：使用共享 ExerciseCard 组件，只读模式（无 onAnswer） */}
      {result.exercises.map((ex, i) => (
        <ExerciseCard
          // biome-ignore lint/suspicious/noArrayIndexKey: exercises list is static (never reordered)
          key={`${ex.type}-${i}`}
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
  // Zod 校验防止结构不符的持久化 JSON 在 .length/.map 处崩溃
  const data = useMemo(
    () => extractJsonSafe(record.result, ListeningResultSchema),
    [record.result],
  );

  if (!data) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  const result = data;

  return (
    <div className="space-y-5">
      {/* 得分概览：青色主题卡片（主题源自注册表） */}
      <ScoreOverviewCard
        theme={scoreOverviews.listening.theme}
        content={scoreOverviews.listening.content(result)}
      />

      {result.sentences.map((s, i) => {
        const userInput = result.userInputs[i]?.trim() ?? "";
        const detail = matchAnswerDetail(userInput, s.text, "rewrite");
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: LLM 可能生成相似句子,截断文本键会碰撞
            key={`${s.text.slice(0, 50)}-${i}`}
            className={`rounded-lg border p-5 space-y-3 ${
              detail === "correct"
                ? "border-green-500/40 bg-green-500/5"
                : detail === "close"
                  ? "border-yellow-500/40 bg-yellow-500/5"
                  : "border-red-500/40 bg-red-500/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">第 {i + 1} 句</span>
              <div className="flex items-center gap-1">
                <SpeakButton text={s.text} />
                {detail === "correct" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : detail === "close" ? (
                  <CheckCircle2 className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                )}
              </div>
            </div>
            <p className="text-sm font-medium text-green-700 dark:text-green-300">{s.text}</p>
            {detail !== "correct" && (
              <p className="text-sm">
                <span className="text-muted-foreground">你的回答：</span>
                <span
                  className={
                    detail === "close"
                      ? "text-yellow-600 dark:text-yellow-400"
                      : "text-red-600 dark:text-red-400"
                  }
                >
                  {userInput || "(未作答)"}
                </span>
              </p>
            )}
            <p className="text-xs text-muted-foreground italic">{s.hint}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 口语练习记录的详情展示子组件。
 *
 * 数据来源：history 表中 type="speaking" 的记录，result 字段为 SpeakingResult JSON。
 *
 * 渲染结构：
 * 1. 得分概览卡片（玫瑰色主题，显示话题 + 难度 + 平均分）
 * 2. 逐句回顾（原句、用户转写、评分、反馈，未完成的句子标记为 skipped）
 *
 * 降级：JSON 解析失败时直接显示原始文本。
 */
function SpeakingDetail({ record }: { record: HistoryRecord }) {
  // Zod 校验防止结构不符的持久化 JSON 在 .map 处崩溃
  const data = useMemo(() => extractJsonSafe(record.result, SpeakingResultSchema), [record.result]);

  if (!data) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{record.result}</div>;
  }

  return (
    <div className="space-y-5">
      {/* 得分概览：玫瑰色主题卡片（主题源自注册表） */}
      <ScoreOverviewCard
        theme={scoreOverviews.speaking.theme}
        content={scoreOverviews.speaking.content(data)}
      />

      {data.results.map((r, i) => {
        // 问题 17: 处理 skipped / score 为 null 的句子（用户未完成的句子）
        const isSkipped = r.skipped === true || r.score === null;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 结果顺序稳定，文本键可能因重复句子碰撞
            key={i}
            className={`rounded-lg border p-5 space-y-3 ${
              isSkipped
                ? "border-muted bg-muted/30"
                : (r.score?.overall ?? 0) >= 80
                  ? "border-green-500/40 bg-green-500/5"
                  : (r.score?.overall ?? 0) >= 60
                    ? "border-yellow-500/40 bg-yellow-500/5"
                    : "border-red-500/40 bg-red-500/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">第 {i + 1} 句</span>
              {isSkipped ? (
                <span className="text-xs text-muted-foreground">未完成</span>
              ) : (
                <span className="text-sm font-bold">{r.score?.overall}</span>
              )}
            </div>
            <p className="text-sm font-medium text-green-700 dark:text-green-300">
              {r.sentence.text}
            </p>
            <p className="text-xs text-muted-foreground">{r.sentence.translation}</p>
            {r.transcription && (
              <p className="text-sm">
                <span className="text-muted-foreground">你说的：</span>
                {r.transcription}
              </p>
            )}
            {!isSkipped && r.score?.feedback && (
              <p className="text-xs text-blue-600 dark:text-blue-400">{r.score.feedback}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 记录类型 → 详情组件的映射表，替代原先的多层三元表达式。
 *  键类型为 HistoryRecord["type"] 联合，TS 强制穷举所有记录类型——
 *  新增类型时漏配会在编译期报错，而非运行时静默回退。 */
const DETAIL_COMPONENTS: Record<HistoryRecord["type"], React.FC<{ record: HistoryRecord }>> = {
  writing: WritingDetail,
  correct: WritingDetail,
  reading: ReadingDetail,
  exercise: ExerciseDetail,
  listening: ListeningDetail,
  speaking: SpeakingDetail,
};

/**
 * 历史详情页面。
 *
 * 根据 URL 参数中的 id 从数据库加载单条历史记录，
 * 根据记录类型经 DETAIL_COMPONENTS 映射渲染对应详情子组件。
 *
 * 路由：/history/:id
 * 数据流：useParams 获取 id → useEffect 加载记录 → 条件渲染子组件
 */
export default function HistoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<HistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 根据 id 加载历史记录。
   *
   * 使用 AbortController 防止组件卸载后的状态更新（React 严格模式下尤其重要）。
   * 当 id 变化或组件卸载时，中止前一次进行中的请求。
   */
  useEffect(() => {
    if (!id) return;

    // 中止前一次请求
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    getHistoryById(Number(id))
      .then((data) => {
        if (!controller.signal.aborted) {
          setRecord(data);
        }
      })
      .catch((e) => {
        // 加载失败必须显式报错：finally 只复位 loading 的话，
        // 错误会被误呈现为"记录不存在"
        if (!controller.signal.aborted) {
          setError(getErrorMessage(e, "记录加载失败"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [id]);

  // 加载中状态
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  // 加载失败：与"记录不存在"区分呈现，避免误导用户以为记录被删
  if (error) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </Button>
        <p className="text-destructive text-center py-12">记录加载失败：{error}</p>
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

  // 脏数据防御：type 不在合法集合时降级提示，而非抛错进 ErrorBoundary
  if (!isHistoryType(record.type)) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </Button>
        <p className="text-muted-foreground text-center py-12">未知记录类型，无法展示详情。</p>
      </div>
    );
  }

  const config = typeConfig[record.type];
  const Icon = config.icon;
  const Detail = DETAIL_COMPONENTS[record.type];

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* 顶部导航栏：返回按钮 + 类型标签 + 时间 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回
        </Button>
        <Badge variant="secondary" className={config.color}>
          <Icon className="h-3 w-3 mr-1" />
          {config.label}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {parseDbTimestamp(record.created_at).toLocaleString("zh-CN")}
        </span>
      </div>

      {/* 用户输入的原文 */}
      <div className="rounded-lg border p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          原文
        </h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{record.input_text}</p>
      </div>

      {/* 根据记录类型渲染不同的详情子组件（映射表穷举所有类型，无需回退） */}
      <Detail record={record} />
    </div>
  );
}
