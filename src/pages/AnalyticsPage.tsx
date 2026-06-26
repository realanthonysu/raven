/**
 * 数据分析页面（Analytics）。
 *
 * 读取所有历史记录（写作/阅读/练习/听力），提供多维度分析：
 * - 8 个概览统计卡片
 * - 学习画像雷达图（语法/词汇/句式/细节 4 维能力评估）
 * - 错误类别分布（柱状图 + 饼图）
 * - 错误趋势折线图
 * - 弱项训练得分趋势图
 * - 听力练习得分趋势图
 * - 近期记录列表
 * - 弱项训练推荐
 *
 * 数据计算逻辑已抽取到 useAnalytics hook，本文件只负责渲染。
 */

import {
  AlertTriangle,
  BarChart3,
  BookCheck,
  BookOpen,
  Dumbbell,
  Headphones,
  Mic,
  Target,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StatCard } from "@/components/analytics/StatCard";
import { EmptyState, LoadingIndicator } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { useAnalytics } from "@/hooks/use-analytics";
import { CATEGORY_COLORS, PIE_COLORS } from "@/lib/analytics";
import { typeConfig } from "@/lib/type-config";

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(0);
  const data = useAnalytics(days);

  if (data.loading) {
    return <LoadingIndicator text="加载中..." className="h-full" />;
  }

  if (data.allRecords.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="暂无学习数据"
        subtitle="开始使用 Writing Copilot、阅读精读、弱项训练或听力练习后，这里会展示学习分析"
        className="h-full"
      />
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">学习分析</h1>
          <p className="text-sm text-muted-foreground">
            基于 {data.allRecords.length} 条学习记录的综合分析
          </p>
        </div>
        <div className="flex gap-1">
          {[
            { label: "7天", value: 7 },
            { label: "30天", value: 30 },
            { label: "90天", value: 90 },
            { label: "全部", value: 0 },
          ].map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={days === opt.value ? "default" : "outline"}
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* === 学习概览 === */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<BarChart3 className="h-4 w-4" />}
          label="总学习次数"
          value={String(data.allRecords.length)}
        />
        <StatCard
          icon={<BookCheck className="h-4 w-4" />}
          label="写作批改"
          value={String(data.correctRecords.length)}
        />
        <StatCard
          icon={<BookOpen className="h-4 w-4" />}
          label="阅读精读"
          value={String(data.readingRecords.length)}
        />
        <StatCard
          icon={<Dumbbell className="h-4 w-4" />}
          label="弱项训练"
          value={String(data.exerciseRecords.length)}
        />
        <StatCard
          icon={<Headphones className="h-4 w-4" />}
          label="听力练习"
          value={String(data.listeningRecords.length)}
        />
        <StatCard
          icon={<Mic className="h-4 w-4" />}
          label="口语练习"
          value={String(data.speakingRecords.length)}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="总错误数"
          value={String(data.totalErrors)}
        />
        <StatCard
          icon={<Target className="h-4 w-4" />}
          label="平均错误/篇"
          value={data.avgErrors}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="错误类型数"
          value={String(data.uniqueCategories)}
          sub={
            data.improvement && data.improvement.diff > 0
              ? `↓ ${data.improvement.pct}% 进步`
              : data.improvement && data.improvement.diff < 0
                ? `↑ ${data.improvement.pct}% 增加`
                : undefined
          }
          subColor={data.improvement && data.improvement.diff < 0 ? "text-red-600" : undefined}
        />
      </div>

      {/* === 学习画像：能力雷达图 === */}
      {data.capabilityData.length > 0 && data.correctRecords.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Target className="h-4 w-4" />
            学习画像
          </h2>
          <div className="flex flex-col items-center">
            <ResponsiveContainer width="100%" height={300}>
              <RadarChart outerRadius={120} data={data.capabilityData}>
                <PolarGrid />
                <PolarAngleAxis
                  dataKey="dimension"
                  tick={{ fontSize: 13, fill: "hsl(var(--foreground))" }}
                />
                <PolarRadiusAxis
                  angle={90}
                  domain={[0, 100]}
                  tick={{ fontSize: 10 }}
                  tickCount={5}
                />
                <Radar
                  name="能力"
                  dataKey="score"
                  stroke="#8884d8"
                  fill="#8884d8"
                  fillOpacity={0.3}
                  strokeWidth={2}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 mt-4">
            {data.capabilityData.map((d) => (
              <div key={d.dimension} className="text-center">
                <p className="text-xs text-muted-foreground">{d.dimension}</p>
                <p
                  className="text-lg font-bold"
                  style={{
                    color: d.score >= 70 ? "#10b981" : d.score >= 40 ? "#f59e0b" : "#ef4444",
                  }}
                >
                  {d.score}
                </p>
                <p className="text-xs">
                  {d.trend === "improving" && <span className="text-green-600">↑ 进步</span>}
                  {d.trend === "declining" && <span className="text-red-500">↓ 退步</span>}
                  {d.trend === "stable" && <span className="text-muted-foreground">→ 稳定</span>}
                  {d.trend === "none" && <span className="text-muted-foreground">—</span>}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t text-sm text-muted-foreground flex gap-6">
            <p>
              <strong className="text-foreground">最强项：</strong>
              {data.bestDimension}
            </p>
            <p>
              <strong className="text-foreground">最弱项：</strong>
              {data.worstDimension}
            </p>
          </div>
        </div>
      )}

      {/* === 错误趋势折线图 === */}
      {data.trendData.length > 1 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误趋势</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.trendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="index" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip
                  formatter={(value: unknown) => [`${value} 个错误`, "错误数"]}
                  labelFormatter={(label: unknown) => `第 ${label} 篇`}
                />
                <Line
                  type="monotone"
                  dataKey="errors"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 错误分布（柱状图 + 饼图） === */}
      {data.categoryData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-4">错误类型分布</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.categoryData}
                  layout="vertical"
                  margin={{ left: 80, right: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={75} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: unknown) => [`${value} 次`, "出现次数"]} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {data.categoryData.map((entry, index) => (
                      <Cell
                        key={entry.name}
                        fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-4">错误类型占比</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={2}
                    dataKey="count"
                    nameKey="name"
                    label={({ name, percent }: { name?: string; percent?: number }) =>
                      `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {data.categoryData.map((entry, index) => (
                      <Cell
                        key={entry.name}
                        fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: unknown) => [`${value} 次`, "出现次数"]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* === 弱项训练成绩趋势 === */}
      {data.exerciseTrendData.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">弱项训练成绩</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.exerciseTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" />
                <Tooltip
                  formatter={(value: unknown) => [`${value}%`, "正确率"]}
                  labelFormatter={(_label: unknown, payload: unknown) =>
                    (payload as Array<{ payload?: { label?: string } }> | undefined)?.[0]?.payload
                      ?.label ?? ""
                  }
                />
                <Line
                  type="monotone"
                  dataKey="scorePercent"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 听力练习成绩趋势 === */}
      {data.listeningTrendData.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">听力练习成绩</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.listeningTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="%" />
                <Tooltip
                  formatter={(value: unknown) => [`${value}%`, "正确率"]}
                  labelFormatter={(_label: unknown, payload: unknown) =>
                    (payload as Array<{ payload?: { label?: string } }> | undefined)?.[0]?.payload
                      ?.label ?? ""
                  }
                />
                <Line
                  type="monotone"
                  dataKey="scorePercent"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 口语练习成绩趋势 === */}
      {data.speakingTrendData.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">口语练习成绩</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.speakingTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} unit="分" />
                <Tooltip
                  formatter={(value: unknown) => [`${value}分`, "得分"]}
                  labelFormatter={(_label: unknown, payload: unknown) =>
                    (payload as Array<{ payload?: { label?: string } }> | undefined)?.[0]?.payload
                      ?.label ?? ""
                  }
                />
                <Line
                  type="monotone"
                  dataKey="scorePercent"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* === 近期记录列表 === */}
      {data.recentSessions.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">近期记录</h2>
          <div className="space-y-2">
            {data.recentSessions.map((s) => {
              const config = typeConfig[s.type];
              if (!config) return null;
              const TypeIcon = config.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="flex items-center justify-between py-2 border-b last:border-0 cursor-pointer hover:bg-muted/50 rounded-sm px-2 -mx-2 transition-colors w-full text-left"
                  onClick={() => navigate(`/history/${s.id}`)}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs shrink-0 ${config.color}`}
                    >
                      <TypeIcon className="h-3 w-3" />
                      {config.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{s.textPreview}</p>
                      <p className="text-xs text-muted-foreground">{s.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0">
                    {s.type === "correct" && s.topCategory && (
                      <>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                          {s.topCategory}
                        </span>
                        <span className="text-sm font-medium text-destructive">
                          {s.total} 处错误
                        </span>
                      </>
                    )}
                    {(s.type === "exercise" || s.type === "listening") &&
                      s.score !== undefined &&
                      s.total !== undefined && (
                        <span className="text-sm font-medium text-primary">
                          {s.score}/{s.total}
                        </span>
                      )}
                    {s.type === "speaking" && s.score !== undefined && (
                      <span className="text-sm font-medium text-primary">{s.score}分</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* === 弱项训练推荐 === */}
      {data.weakCategories.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">弱项训练</h2>
          <p className="text-xs text-muted-foreground mb-4">
            基于最近 10 篇批改记录，系统推荐以下弱项进行专项训练
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.weakCategories.map((cat) => (
              <div
                key={cat.name}
                className="flex items-center justify-between p-3 border rounded-lg hover:border-primary/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-orange-500/10 flex items-center justify-center">
                    <Dumbbell className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{cat.name}</p>
                    <p className="text-xs text-muted-foreground">近 10 篇出现 {cat.count} 次</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => navigate(`/exercise/${encodeURIComponent(cat.name)}`)}
                >
                  开始训练
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
