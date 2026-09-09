/**
 * Dashboard 首页 -- 提供主动式学习引导，汇总待复习词汇、弱项分析、
 * 学习连续打卡、近期活动，并给出一键跳转入口。
 *
 * 数据一次性并行加载：getHistoryList（轻量元数据，不含 result/graph_data 大字段）、
 * getHistoryWithResults（按需配对结果文本）、getReviewStats、getLearningStreak。
 * 历史列表仅取最近 5 条用于时间线，弱项分析等结果解析按 id 配对获取。
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
import {
  getHistoryList,
  getHistoryOldestDate,
  getHistoryWithResults,
  getLearningStreak,
  getReviewStats,
  type HistoryWithResults,
  parseDbTimestamp,
  type ReviewStats,
} from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import {
  applyMasteryWeight,
  type CategoryMastery,
  computeCategoryMastery,
  countCorrectionCategories,
  parseExerciseAttempts,
} from "@/lib/exercise-stats";
import { summarizeRecord } from "@/lib/history-presentation";
import { extractJsonSafe } from "@/lib/parse-utils";
import { CorrectionResultSchema } from "@/lib/schemas";
import { CATEGORY_EXERCISE_TYPE, isHistoryType, typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

// ============================================================================
// Local helpers
// ============================================================================

/** 时段问候语 */
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 相对日期格式化：今天 / 昨天 / N天前 / 日期 */
function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
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
    setData(null);

    await wrapFetch(async (signal) => {
      try {
        // 拆分为多个精准轻量调用，避免一次性全量拉取含重型 result/graph_data 的记录：
        // 1. 时间线：仅需 5 条轻量记录（不含 result/graph_data）
        // 2. 弱项分析 + 时间线写作摘要：写作 result 统一取最近 20 条——
        //    时间线里的写作记录必然是"最新 20 条写作"的子集，一次查询覆盖两处
        //    （替代原先 getRecentCorrectResults(20) 与 getHistoryResultsByType 的重叠查询）
        // 3. 使用天数：仅需最早记录的 created_at
        const [
          stats,
          streak,
          recentRecords,
          writingData,
          exerciseData,
          listeningSpeakingData,
          oldestDate,
        ] = await Promise.all([
          getReviewStats(signal),
          getLearningStreak(signal),
          getHistoryList(undefined, 5),
          // 写作数据是弱项分析的核心：仅记录列表失败才整体报错（result 失败在
          // getHistoryWithResults 内部 fail-soft 为空 Map）
          getHistoryWithResults(["correct", "writing"], 20),
          // 练习记录获取失败不阻塞面板（降权为可选增强）
          // limit=15：掌握度加权只需最近若干次练习即可，50 条 result 纯属 IPC 浪费
          getHistoryWithResults("exercise", 15).catch(() => EMPTY_WITH_RESULTS),
          // 听力/口语 result 仅用于时间线分数摘要，limit=5 已覆盖
          // 最近 5 条记录中该类型的全部条目
          getHistoryWithResults(["listening", "speaking"], 5).catch(() => EMPTY_WITH_RESULTS),
          getHistoryOldestDate(),
        ]);

        if (signal.aborted) return;

        // 按 id 关联 result，供 summarizeRecord 提取分数摘要
        // （各类型 id 互不重叠，合并顺序无关紧要）
        const recentResultByRecordId = new Map<number, string>();
        for (const bundle of [writingData, exerciseData, listeningSpeakingData]) {
          for (const [id, result] of bundle.resultById) {
            recentResultByRecordId.set(id, result);
          }
        }

        // ── 从写作 result 中提取错误类别频次，经练习掌握度降权后取最弱项 ──
        let topCategory: TopCategory | null = null;
        {
          const corrections = [...writingData.resultById.values()].flatMap((resultStr) => {
            const parsed = extractJsonSafe(resultStr, CorrectionResultSchema);
            return parsed?.corrections ?? [];
          });
          const catMap = countCorrectionCategories(corrections);
          if (catMap.size > 0) {
            // 掌握度的"最近 N 次"窗口由练习记录 created_at 显式排序推导，
            // 与查询返回顺序无关
            const mastery = computeCategoryMastery(
              parseExerciseAttempts(
                exerciseData.records.map((r) => ({
                  createdAt: r.created_at,
                  result: exerciseData.resultById.get(r.id) ?? "",
                })),
              ),
            );

            const ranked = applyMasteryWeight(
              [...catMap.entries()].map(([name, count]) => ({ name, count })),
              mastery,
            );
            const top = ranked[0];
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
            Math.floor(
              (Date.now() - parseDbTimestamp(oldestDate).getTime()) / (1000 * 60 * 60 * 24),
            ) + 1,
          );
        }

        setData({
          reviewStats: stats,
          streak,
          daysSinceFirst,
          topCategory,
          recentRecords,
          recentResultByRecordId,
        });
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
