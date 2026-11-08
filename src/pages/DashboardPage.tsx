/**
 * Dashboard 首页 -- 提供主动式学习引导，汇总待复习词汇、弱项分析、
 * 学习连续打卡、近期活动，并给出一键跳转入口。
 *
 * 数据一次性并行加载：getSidebarData（复习统计 + 连续天数，与 Sidebar/通知共享
 * 短 TTL 聚合快照）、getHistoryList（轻量元数据，不含 result/graph_data 大字段）、
 * getHistoryWithResults（按需配对结果文本）。历史列表仅取最近 5 条用于时间线，
 * 弱项分析等结果解析按 id 配对获取。
 * 失败分级：核心查询（聚合统计、历史列表/结果）失败整页报错；附属查询
 * （首次使用天数）失败降级为 null，不阻塞主面板。
 * H-15：整个「查询 + 解析 + 弱项聚合」派生结果有 5s 短 TTL 缓存，快速往返首页
 * 不重复拉取/解析（失效策略见 DASHBOARD_DATA_TTL_MS 注释）。
 */

import {
  BookCheck,
  BookOpen,
  CalendarDays,
  ChevronRight,
  Dumbbell,
  Flame,
  Headphones,
  Lightbulb,
  PenLine,
  RefreshCw,
  Repeat,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ErrorBanner, LoadingIndicator } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAbortable } from "@/hooks/use-abortable";
import { createCachedFetcher } from "@/lib/cache";
import {
  getHistoryList,
  getHistoryOldestDate,
  getHistoryWithResults,
  getSidebarData,
  type HistoryWithResults,
  parseDbTimestamp,
  type ReviewStats,
  WRITING_TYPES,
} from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  type CategoryMastery,
  parseExerciseAttempts,
  rankWeakCategories,
} from "@/lib/exercise-stats";
import { summarizeRecord } from "@/lib/history-presentation";
import { groupAndParseResults } from "@/lib/level-estimation-samples";
import { CATEGORY_EXERCISE_TYPE, isHistoryType, typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

// ============================================================================
// Local helpers
// ============================================================================

/** 弱项分析的统计窗口：只看最近 20 篇写作（查询 limit=20 已框定，
 *  此处与 Analytics 编排层的 10 篇/top2 是刻意的展示口径差异，管线共享
 *  rankWeakCategories） */
const DASHBOARD_WEAK_WINDOW = 20;
/** Dashboard 只展示最弱的一项 */
const DASHBOARD_WEAK_TOP_N = 1;

/** 时段问候语 */
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 相对日期格式化：今天 / 昨天 / N天前 / 日期 */
function formatRelativeDate(dateStr: string): string {
  // created_at 是 UTC 无时区标记的存储串，必须经 parseDbTimestamp 解析——
  // 裸 new Date(dateStr) 会按本地时间解释该串，UTC+8 用户当天 00:00-08:00
  // 创建的记录会被算成"昨天"，超过 7 天的记录展示日期也整体退一天
  const d = parseDbTimestamp(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays}天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// ============================================================================
// Types
// ============================================================================

/** 最常见错误类别信息，用于弱项分析卡片 */
interface TopCategory {
  /** 错误类别名称 */
  name: string;
  /** 该类别在近 20 篇写作中的出现次数 */
  count: number;
  /** 对应的弱项训练类型标识，无匹配时为 null */
  exerciseType: string | null;
  /** 该类别的练习掌握度，未练习过时为 null */
  mastery: CategoryMastery | null;
}

/** getHistoryWithResults 的 fail-soft 空结果：可选增强数据失败时的降级占位 */
const EMPTY_WITH_RESULTS: HistoryWithResults = { records: [], resultById: new Map() };

/**
 * Dashboard 派生数据的短 TTL（毫秒）。
 *
 * H-15：Dashboard 每次挂载都会并行发起 6 条查询，并在主线程解析 20 条写作 +
 * 50 条练习 result（含 Zod）。短 TTL 缓存把「查询 + 解析 + 弱项聚合」整体
 * 缓存 5s：在任务页/设置页之间快速往返时直接复用，避免重复 6 次 IPC 与
 * 70 次解析。失效策略：
 * - 自然过期（5s）为主——学习结果写入后通常已超过该窗口；重试按钮会显式失效；
 * - reviewStats/streak 来自 `getSidebarData()` 的共享快照（D-07/S-05），
 *   `recordLearningActivity*` / `setLearningGoal` 已使其立即失效，Dashboard
 *   派生快照最多再陈旧一个 TTL 窗口（见下）。
 */
const DASHBOARD_DATA_TTL_MS = 5_000;

/**
 * 拉取并派生 Dashboard 全部数据（无 signal、可缓存）。
 *
 * 查询分级保持原语义：核心查询（聚合统计、历史列表、写作结果）失败 → 整页报错；
 * 练习/听力口语结果、首次使用日期失败 → 降级为空/ null。
 *
 * D-07/S-05：reviewStats 与 streak 不再各发一次 IPC，改用与 Sidebar/通知/
 * GoalsProvider 共享的 `getSidebarData()` 短 TTL 聚合快照（同一次
 * db_get_sidebar_data）。因此这两个字段的失败表现为聚合命令失败 → 整页报错
 * （与原 reviewStats 核心查询语义一致；streak 不再能独立降级为 0）。
 */
async function fetchDashboardData(): Promise<DashboardData> {
  const [sidebar, recentRecords, writingData, exerciseData, listeningSpeakingData, oldestDate] =
    await Promise.all([
      // 复习统计 + 连续天数：共享短 TTL 聚合快照（Sidebar/通知/Goals 同一份 IPC）
      getSidebarData(),
      // 时间线：仅需 5 条轻量记录（不含 result/graph_data）
      getHistoryList(undefined, 5),
      // 写作数据是弱项分析的核心：仅记录列表失败才整体报错（result 失败在
      // getHistoryWithResults 内部 fail-soft 为空 Map）
      getHistoryWithResults(WRITING_TYPES, 20),
      // 练习记录获取失败不阻塞面板（降权为可选增强）
      // limit=50：掌握度加权算法需要每类别最近 2-3 次练习记录，
      // 全类别混合窗口若再缩小会导致某类别近期记录整体跌出窗口、算法失效
      getHistoryWithResults("exercise", 50).catch(() => EMPTY_WITH_RESULTS),
      // 听力/口语 result 仅用于时间线分数摘要，limit=5 已覆盖
      // 最近 5 条记录中该类型的全部条目
      getHistoryWithResults(["listening", "speaking"], 5).catch(() => EMPTY_WITH_RESULTS),
      getHistoryOldestDate().catch(() => null),
    ]);

  // 按 id 关联 result，供 summarizeRecord 提取分数摘要
  // （各类型 id 互不重叠，合并顺序无关紧要）
  const recentResultByRecordId = new Map<number, string>();
  for (const bundle of [writingData, exerciseData, listeningSpeakingData]) {
    for (const [id, result] of bundle.resultById) {
      recentResultByRecordId.set(id, result);
    }
  }

  // ── 弱项分析：与 Analytics 编排层共用 rankWeakCategories 管线 ──
  // 写作 bundle 经 groupAndParseResults 解析（按类型分 schema 的共享派发，
  // 此前此处内联的 extractJsonSafe + CorrectionResultSchema 循环已删除，
  // 解析入口回归一处定义）；练习摘要仍走 parseExerciseAttempts。
  let topCategory: TopCategory | null = null;
  {
    const parsedWriting = groupAndParseResults(writingData.records, writingData.resultById).correct;
    const ranked = rankWeakCategories({
      categoriesPerArticle: parsedWriting.map((p) => p.result.corrections.map((c) => c.category)),
      // 掌握度的"最近 N 次"窗口由练习记录 created_at 显式排序推导，
      // 与查询返回顺序无关
      exerciseAttempts: parseExerciseAttempts(
        exerciseData.records.map((r) => ({
          createdAt: r.created_at,
          result: exerciseData.resultById.get(r.id) ?? "",
        })),
      ),
      window: DASHBOARD_WEAK_WINDOW,
      topN: DASHBOARD_WEAK_TOP_N,
    });
    const top = ranked[0];
    if (top) {
      topCategory = {
        name: top.name,
        count: top.count,
        exerciseType: CATEGORY_EXERCISE_TYPE[top.name] ?? null,
        mastery: top.mastery,
      };
    }
  }

  // ── 计算首次使用距今天数 ──
  let daysSinceFirst: number | null = null;
  if (oldestDate) {
    daysSinceFirst = Math.max(
      1,
      Math.floor((Date.now() - parseDbTimestamp(oldestDate).getTime()) / (1000 * 60 * 60 * 24)) + 1,
    );
  }

  return {
    reviewStats: sidebar.reviewStats,
    streak: sidebar.streak,
    daysSinceFirst,
    topCategory,
    recentRecords,
    recentResultByRecordId,
  };
}

/** Dashboard 派生数据缓存：并发去重 + 5s TTL（H-15） */
const dashboardDataCache = createCachedFetcher(fetchDashboardData, {
  ttlMs: DASHBOARD_DATA_TTL_MS,
});

/**
 * 显式失效 Dashboard 短 TTL 快照（重试按钮用；测试 beforeEach 也用它隔离模块级缓存）。
 * 题面要求「写出失效策略」：学习活动/目标写入经 `lib/db/learning.ts` 使更底层的
 * 侧栏聚合快照立即失效，但 Dashboard 派生快照（含 70 条 result 解析结果）只有
 * 5s TTL 自然过期；这是刻意的取舍——为历史写入回调 Dashboard 缓存需要让
 * 数据层反向依赖页面模块，收益不值得。
 */
export function invalidateDashboardDataCache(): void {
  dashboardDataCache.invalidate();
}

/** Dashboard 页面一次性加载的全部数据 */
interface DashboardData {
  /** 复习统计信息（待学习/学习中/已掌握等） */
  reviewStats: ReviewStats;
  /** 连续学习打卡天数 */
  streak: number;
  /** 距首次使用的天数，无记录时为 null */
  daysSinceFirst: number | null;
  /** 最常见错误类别，无写作记录时为 null */
  topCategory: TopCategory | null;
  /** 最近 5 条学习记录，用于时间线展示 */
  recentRecords: HistoryRecord[];
  /** 时间线记录的 result 内容（按记录 id 关联），用于展示分数摘要。
   *  由各 getHistoryWithResults 的 resultById 合并而来（按 id 配对，与顺序无关）。 */
  recentResultByRecordId: Map<number, string>;
}

// ============================================================================
// Component
// ============================================================================

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { wrapFetch } = useAbortable();

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);

    await wrapFetch(async (signal) => {
      try {
        // H-15：短 TTL 缓存命中时直接复用「查询 + 解析 + 弱项聚合」结果，
        // 避免每次返回首页重复 6 条查询与 70 次 result 解析。
        // 缓存 promise 与 Sidebar/通知共享底层聚合快照（D-07/S-05）。
        const next = await dashboardDataCache.cached();
        if (signal.aborted) return;
        setData(next);
      } catch (e) {
        if (!signal.aborted) {
          setError(getErrorMessage(e, "加载失败"));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
  }, [wrapFetch]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const handleRetry = useCallback(() => {
    // 重试必须绕过短 TTL 缓存：失败可能来自过期快照之外的瞬时错误
    invalidateDashboardDataCache();
    loadDashboard();
  }, [loadDashboard]);

  if (loading) {
    return <LoadingIndicator text="加载面板..." className="h-full" />;
  }

  if (error) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <ErrorBanner message={error} />
        <Button variant="outline" onClick={handleRetry}>
          <RefreshCw className="h-4 w-4" />
          重试
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return <DashboardContent data={data} />;
}

// ============================================================================
// Dashboard content (rendered only when data is guaranteed non-null)
// ============================================================================

/**
 * Dashboard 内容区域组件，在数据加载完成后渲染。
 *
 * @param props - 组件属性
 * @param props.data - 已加载的 Dashboard 数据，保证非 null
 * @returns Dashboard 内容的 JSX 元素
 */
function DashboardContent({ data }: { data: DashboardData }) {
  const navigate = useNavigate();
  const { reviewStats: review } = data;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* ── 问候 + 打卡 ── */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{getGreeting()}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data.streak > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <Flame className="h-4 w-4 text-orange-500" />
                已连续学习 <span className="font-semibold text-foreground">{data.streak}</span> 天
              </span>
            ) : (
              "开始今天的学习吧"
            )}
            {data.daysSinceFirst !== null && (
              <span className="ml-2 text-muted-foreground">
                · 已加入 Raven {data.daysSinceFirst} 天
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ── 第一行：今日复习 + 弱项类别 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 今日复习摘要 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Repeat className="h-4 w-4 text-primary" />
                待复习词汇
              </CardTitle>
              <span className="text-2xl font-bold text-primary">{review.dueCount}</span>
            </div>
          </CardHeader>
          <CardContent>
            {review.total === 0 ? (
              <p className="text-sm text-muted-foreground">
                生词本暂无词汇，从阅读或写作中添加生词吧
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-blue-500/10 px-3 py-2">
                  <p className="text-xs text-blue-600 dark:text-blue-400">待学习</p>
                  <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
                    {review.newCount}
                  </p>
                </div>
                <div className="rounded-lg bg-amber-500/10 px-3 py-2">
                  <p className="text-xs text-amber-600 dark:text-amber-400">学习中</p>
                  <p className="text-lg font-bold text-amber-600 dark:text-amber-400">
                    {review.learningCount}
                  </p>
                </div>
                <div className="rounded-lg bg-green-500/10 px-3 py-2">
                  <p className="text-xs text-green-600 dark:text-green-400">已掌握</p>
                  <p className="text-lg font-bold text-green-600 dark:text-green-400">
                    {review.masteredCount}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
          {review.dueCount > 0 && (
            <div className="flex items-center justify-end px-4 pb-4">
              <Button size="sm" onClick={() => navigate("/review")}>
                去复习 <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </Card>

        {/* 弱项类别 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              弱项分析
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.topCategory ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">最近写作中最常见错误</p>
                    <p className="text-lg font-semibold mt-1">{data.topCategory.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      近 20 篇写作中出现 {data.topCategory.count} 次
                    </p>
                    {/* 掌握度追踪：练习过的类别展示进度，形成反馈闭环 */}
                    {data.topCategory.mastery && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        已练 {data.topCategory.mastery.attempts} 次 · 近期正确率{" "}
                        {data.topCategory.mastery.recentAccuracy}%
                      </p>
                    )}
                  </div>
                  <div className="h-12 w-12 rounded-full bg-orange-500/10 flex items-center justify-center">
                    <Dumbbell className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                  </div>
                </div>
                {data.topCategory.exerciseType && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      navigate(`/exercise/${encodeURIComponent(data.topCategory?.name ?? "")}`)
                    }
                  >
                    针对训练 <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">
                  使用写作批改后，这里会显示你的薄弱项分析
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 快速入口 ── */}
      <div>
        <h2 className="text-sm font-semibold mb-3">快速开始</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <ActionCard
            icon={PenLine}
            label="写作批改"
            color="text-green-600 dark:text-green-400"
            bg="bg-green-500/10"
            lastDate={
              data.recentRecords.find((r) => r.type === "correct" || r.type === "writing")
                ?.created_at ?? null
            }
            onClick={() => navigate("/writing")}
          />
          <ActionCard
            icon={BookOpen}
            label="阅读精读"
            color="text-purple-600 dark:text-purple-400"
            bg="bg-purple-500/10"
            lastDate={data.recentRecords.find((r) => r.type === "reading")?.created_at ?? null}
            onClick={() => navigate("/reading")}
          />
          <ActionCard
            icon={Headphones}
            label="听力练习"
            color="text-cyan-600 dark:text-cyan-400"
            bg="bg-cyan-500/10"
            lastDate={data.recentRecords.find((r) => r.type === "listening")?.created_at ?? null}
            onClick={() => navigate("/listening")}
          />
          <ActionCard
            icon={BookCheck}
            label="词汇复习"
            color="text-blue-600 dark:text-blue-400"
            bg="bg-blue-500/10"
            lastDate={null}
            onClick={() => navigate("/review")}
          />
        </div>
      </div>

      {/* ── 近期学习时间线 ── */}
      {data.recentRecords.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              近期学习
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground h-7"
              onClick={() => navigate("/history")}
            >
              查看全部 <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              {data.recentRecords.map((record, i) => {
                // 脏数据防御：type 非法时跳过该条，避免 config 未定义崩溃
                if (!isHistoryType(record.type)) return null;
                const config = typeConfig[record.type];
                const TypeIcon = config.icon;
                const summary = summarizeRecord(record, data.recentResultByRecordId.get(record.id));
                return (
                  <button
                    key={record.id}
                    type="button"
                    className={`flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors cursor-pointer ${
                      i < data.recentRecords.length - 1 ? "border-b" : ""
                    }`}
                    onClick={() => navigate(`/history/${record.id}`)}
                  >
                    <span
                      className={`inline-flex items-center justify-center h-8 w-8 rounded-lg shrink-0 ${config.color}`}
                    >
                      <TypeIcon className="h-4 w-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{config.label}</span>
                        {summary.scoreText && (
                          <span className="text-xs text-muted-foreground">{summary.scoreText}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {summary.preview}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatRelativeDate(record.created_at)}
                    </span>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

interface ActionCardProps {
  icon: React.ElementType;
  label: string;
  color: string;
  bg: string;
  lastDate: string | null;
  onClick: () => void;
}

/**
 * 快速入口卡片组件，展示功能入口图标、名称和最近使用时间。
 *
 * @param props - {@link ActionCardProps}
 * @returns 卡片按钮的 JSX 元素
 */
function ActionCard({ icon: Icon, label, color, bg, lastDate, onClick }: ActionCardProps) {
  return (
    <button
      type="button"
      className="flex flex-col items-start gap-3 p-4 border rounded-xl hover:border-primary/40 hover:bg-muted/30 transition-all cursor-pointer text-left"
      onClick={onClick}
    >
      <div className={`h-10 w-10 rounded-lg ${bg} flex items-center justify-center`}>
        <Icon className={`h-5 w-5 ${color}`} />
      </div>
      <div className="w-full">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {lastDate ? `${formatRelativeDate(lastDate)}使用` : "点击开始"}
        </p>
      </div>
    </button>
  );
}
