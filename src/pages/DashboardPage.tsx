/**
 * Dashboard 首页 -- 提供主动式学习引导，汇总待复习词汇、弱项分析、
 * 学习连续打卡、近期活动，并给出一键跳转入口。
 *
 * 数据一次性加载：getHistory + getReviewStats + getLearningStreak 并行请求，
 * 历史记录取 500 条，同时用于弱项分析、近期活动和首次使用日期计算。
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
import { useNavigate } from "react-router-dom";
import { ErrorBanner, LoadingIndicator } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHistory, getLearningStreak, getReviewStats, type ReviewStats } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { CATEGORY_EXERCISE_TYPE, typeConfig } from "@/lib/type-config";
import type { CorrectionResult, ExerciseResult, HistoryRecord, ListeningResult } from "@/types";

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

interface TopCategory {
  name: string;
  count: number;
  exerciseType: string | null;
}

interface DashboardData {
  reviewStats: ReviewStats;
  streak: number;
  daysSinceFirst: number | null;
  topCategory: TopCategory | null;
  recentRecords: HistoryRecord[];
}

// ============================================================================
// Component
// ============================================================================

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadDashboard() {
      try {
        // 并行发出：review 统计 + 打卡连续天数 + 历史记录
        // 历史记录取 500 条，同时用于弱项分析（取前 20 条 correct）、
        // 近期活动（取前 5 条）和首次使用日期（取末尾最老的记录）
        const [stats, streak, records] = await Promise.all([
          getReviewStats(),
          getLearningStreak(),
          getHistory(undefined, 500),
        ]);

        if (controller.signal.aborted) return;

        // ── 从写作记录中提取最常见错误类别 ──
        const recentWriting = records
          .filter((r) => r.type === "correct" || r.type === "writing")
          .slice(0, 20);
        let topCategory: TopCategory | null = null;
        {
          const catMap = new Map<string, number>();
          for (const r of recentWriting) {
            const parsed = extractJson<CorrectionResult>(r.result);
            if (!parsed?.corrections) continue;
            for (const c of parsed.corrections) {
              if (c.category) catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
            }
          }
          if (catMap.size > 0) {
            const [name, count] = [...catMap.entries()].sort((a, b) => b[1] - a[1])[0];
            topCategory = {
              name,
              count,
              exerciseType: CATEGORY_EXERCISE_TYPE[name] ?? null,
            };
          }
        }

        // ── 计算首次使用距今天数（取记录集中最早的一条） ──
        let daysSinceFirst: number | null = null;
        if (records.length > 0) {
          const oldest = records.reduce((min, r) => (r.created_at < min.created_at ? r : min));
          daysSinceFirst = Math.max(
            1,
            Math.floor(
              (Date.now() - new Date(oldest.created_at).getTime()) / (1000 * 60 * 60 * 24),
            ) + 1,
          );
        }

        setData({
          reviewStats: stats,
          streak,
          daysSinceFirst,
          topCategory,
          recentRecords: records.slice(0, 5),
        });
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "加载失败");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadDashboard();
    return () => controller.abort();
  }, []);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    setData(null);
    window.location.reload();
  }, []);

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
                const config = typeConfig[record.type];
                const TypeIcon = config.icon;
                const summary = getRecordSummary(record);
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * 从历史记录中提取摘要信息，用于时间线展示。
 * - correct: 错误数量
 * - exercise: 得分
 * - listening: 得分
 * - reading: 文本片段
 */
function getRecordSummary(record: HistoryRecord): {
  preview: string;
  scoreText: string | null;
} {
  const preview =
    record.input_text.length > 50 ? `${record.input_text.slice(0, 50)}...` : record.input_text;

  if (record.type === "correct") {
    const parsed = extractJson<CorrectionResult>(record.result);
    if (parsed) {
      return {
        preview: parsed.summary?.slice(0, 50) || preview,
        scoreText: `${parsed.corrections.length} 处错误`,
      };
    }
  }

  if (record.type === "exercise") {
    const parsed = extractJson<ExerciseResult>(record.result);
    if (parsed) {
      return {
        preview: `${parsed.category} 训练`,
        scoreText: `${parsed.score}/${parsed.exercises.length}`,
      };
    }
  }

  if (record.type === "listening") {
    const parsed = extractJson<ListeningResult>(record.result);
    if (parsed) {
      return {
        preview: parsed.topic || preview,
        scoreText: `${parsed.score}/${parsed.sentences.length}`,
      };
    }
  }

  return { preview, scoreText: null };
}
