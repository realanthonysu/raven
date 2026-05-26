import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getHistory } from "@/lib/db";
import type { HistoryRecord, CorrectionResult } from "@/types";
import { BarChart3, TrendingUp, FileText, AlertTriangle, Target, Dumbbell } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from "recharts";

/** 错误类型分布的统计数据 */
interface CategoryStat {
  name: string;
  count: number;
}

/** 趋势图中的单个数据点 */
interface TrendPoint {
  date: string;
  errors: number;
  index: number; // 第 N 篇
}

/** 最近会话详情列表的单条记录 */
interface SessionDetail {
  id: number;
  date: string;
  textPreview: string;
  totalErrors: number;
  topCategory: string; // 出现最多的错误类别
}

/** 各错误类别的固定颜色映射，确保柱状图和饼图中同一类别颜色一致 */
const CATEGORY_COLORS: Record<string, string> = {
  "主谓一致": "#3b82f6",
  "冠词错误": "#8b5cf6",
  "单复数": "#06b6d4",
  "用词不当": "#f59e0b",
  "时态错误": "#ef4444",
  "拼写错误": "#10b981",
  "介词错误": "#ec4899",
  "句式杂糅": "#6366f1",
  "标点错误": "#14b8a6",
  "缺少成分": "#f97316",
  "语序错误": "#a855f7",
};

/** 饼图的备用颜色（当类别不在 CATEGORY_COLORS 中时使用） */
const PIE_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444",
  "#10b981", "#ec4899", "#6366f1", "#14b8a6", "#f97316", "#a855f7",
];

/** 安全解析 JSON 字符串，失败返回 null */
function parseResult(json: string): CorrectionResult | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 数据分析页面（Analytics）。
 *
 * 功能：基于所有 type='correct' 的历史记录，生成写作纠错的学习分析报告。
 * 不新增数据库表——所有统计数据从现有 history 表的 result JSON 字段派生。
 *
 * 页面结构：
 * 1. 概览卡片（4 个 StatCard）— 批改篇数、总错误数、平均错误/篇、错误类型数 + 进步百分比
 * 2. 错误趋势折线图 — 按时间顺序展示每篇的错误数，观察改进趋势
 * 3. 错误类型分布柱状图 + 饼图 — 并排展示各错误类别的出现次数和占比
 * 4. 最近批改记录列表 — 最近 10 篇的摘要、日期、主要错误类别
 *
 * 数据流：
 * - useEffect 加载所有 correct 类型的 history 记录
 * - useMemo 链式派生：records → parsed（过滤解析失败的）→ categoryData / trendData / recentSessions
 * - improvement 通过前后半段均值对比计算进步百分比
 */
export default function AnalyticsPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  /** 挂载时加载所有写作纠错记录 */
  useEffect(() => {
    getHistory("correct").then((r) => {
      setRecords(r);
      setLoading(false);
    });
  }, []);

  /**
   * 解析所有记录的 result JSON，过滤掉解析失败的。
   * 这是所有后续统计的基础数据源。
   */
  const parsed = useMemo(() => {
    return records
      .map((r) => ({ record: r, result: parseResult(r.result) }))
      .filter((x): x is { record: HistoryRecord; result: CorrectionResult } => x.result !== null);
  }, [records]);

  // === 概览统计 ===
  const totalArticles = parsed.length;
  const totalErrors = parsed.reduce((sum, p) => sum + p.result.corrections.length, 0);
  const avgErrors = totalArticles > 0 ? (totalErrors / totalArticles).toFixed(1) : "0";

  /** 统计所有错误类别的出现次数（Map<category, count>） */
  const allCategories = useMemo(() => {
    const map = new Map<string, number>();
    parsed.forEach((p) =>
      p.result.corrections.forEach((c) => {
        map.set(c.category, (map.get(c.category) ?? 0) + 1);
      })
    );
    return map;
  }, [parsed]);

  const uniqueCategories = allCategories.size;

  /** 柱状图和饼图的数据：按出现次数降序排列 */
  const categoryData: CategoryStat[] = useMemo(() => {
    return Array.from(allCategories.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allCategories]);

  /** 折线图数据：按时间排序，每篇对应一个数据点 */
  const trendData: TrendPoint[] = useMemo(() => {
    const sorted = [...parsed].sort(
      (a, b) => new Date(a.record.created_at).getTime() - new Date(b.record.created_at).getTime()
    );
    return sorted.map((p, i) => ({
      date: new Date(p.record.created_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }),
      errors: p.result.corrections.length,
      index: i + 1,
    }));
  }, [parsed]);

  /**
   * 改进趋势：将所有记录按时间均分为前后两半，
   * 比较平均错误数的变化。diff > 0 表示进步（错误减少）。
   */
  const improvement = useMemo(() => {
    if (trendData.length < 2) return null;
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid);
    const secondHalf = trendData.slice(mid);
    const avgFirst = firstHalf.reduce((s, d) => s + d.errors, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d.errors, 0) / secondHalf.length;
    const diff = avgFirst - avgSecond;
    const pct = avgFirst > 0 ? ((diff / avgFirst) * 100).toFixed(0) : "0";
    return { diff, pct, avgFirst: avgFirst.toFixed(1), avgSecond: avgSecond.toFixed(1) };
  }, [trendData]);

  /** 最近 10 篇批改记录的摘要信息 */
  const recentSessions: SessionDetail[] = useMemo(() => {
    return parsed.slice(0, 10).map((p) => {
      // 统计该篇中出现最多的错误类别
      const catMap = new Map<string, number>();
      p.result.corrections.forEach((c) => catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1));
      const topCategory = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
      return {
        id: p.record.id,
        date: new Date(p.record.created_at).toLocaleDateString("zh-CN"),
        textPreview: p.record.input_text.slice(0, 60) + (p.record.input_text.length > 60 ? "..." : ""),
        totalErrors: p.result.corrections.length,
        topCategory,
      };
    });
  }, [parsed]);

  /**
   * 弱项推荐算法。
   *
   * 输入：parsed 数组（所有写作批改记录的解析结果）
   * 输出：频次最高的 1-2 个错误类别（{ name, count }[]）
   *
   * 算法步骤：
   * 1. 取最近 10 篇记录（越近的越能反映当前水平）
   * 2. 遍历每篇的 corrections 数组，统计各 category 的出现次数
   * 3. 按频次降序排序，取 top 2
   *
   * 使用 useMemo 缓存，仅在 parsed 变化时重新计算。
   * 下游使用：渲染"弱项训练"推荐卡片，点击后导航到 /exercise/:category。
   */
  const weakCategories: { name: string; count: number }[] = useMemo(() => {
    const recent = parsed.slice(0, 10); // 最近 10 篇，越新越有参考价值
    if (recent.length === 0) return [];

    // 统计各错误类别的出现频次
    const catMap = new Map<string, number>();
    recent.forEach((p) =>
      p.result.corrections.forEach((c) => {
        catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
      })
    );

    // 按频次降序，取 top 2 作为推荐
    return Array.from(catMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 2);
  }, [parsed]);

  // 加载中
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // 空状态：没有任何纠错记录
  if (parsed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <BarChart3 className="h-12 w-12" />
        <p className="text-sm">暂无写作批改数据</p>
        <p className="text-xs">使用 Writing Copilot 批改文章后，这里会展示学习分析</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-bold tracking-tight">学习分析</h1>
        <p className="text-sm text-muted-foreground">基于 {totalArticles} 篇写作批改记录</p>
      </div>

      {/* 概览卡片：4 个关键指标 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<FileText className="h-4 w-4" />} label="批改篇数" value={String(totalArticles)} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="总错误数" value={String(totalErrors)} />
        <StatCard icon={<Target className="h-4 w-4" />} label="平均错误/篇" value={avgErrors} />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="错误类型数"
          value={String(uniqueCategories)}
          sub={improvement && improvement.diff > 0 ? `↓ ${improvement.pct}% 进步` : improvement && improvement.diff < 0 ? `↑ ${improvement.pct}% 增加` : undefined}
        />
      </div>

      {/* 错误趋势折线图（至少 2 篇数据才显示） */}
      {trendData.length > 1 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误趋势</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="index" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip
                  formatter={(value: any) => [`${value} 个错误`, "错误数"]}
                  labelFormatter={(label: any) => `第 ${label} 篇`}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 错误类型分布 - 水平柱状图（中文标签需要更多左侧空间） */}
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误类型分布</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData} layout="vertical" margin={{ left: 80, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={75}
                  tick={{ fontSize: 12 }}
                />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any) => [`${value} 次`, "出现次数"]} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {categoryData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 错误类型占比 - 环形饼图（内半径 50 形成环形效果） */}
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">错误类型占比</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="count"
                  nameKey="name"
                  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                  label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {categoryData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CATEGORY_COLORS[entry.name] ?? PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(value: any) => [`${value} 次`, "出现次数"]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* 最近批改记录列表（最多 10 条） */}
      {recentSessions.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">最近批改记录</h2>
          <div className="space-y-2">
            {/* 可点击跳转到该条记录的详情页（HistoryDetailPage） */}
            {recentSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between py-2 border-b last:border-0 cursor-pointer hover:bg-muted/50 rounded-sm px-2 -mx-2 transition-colors"
                onClick={() => navigate(`/history/${s.id}`)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{s.textPreview}</p>
                  <p className="text-xs text-muted-foreground">{s.date}</p>
                </div>
                <div className="flex items-center gap-3 ml-4 shrink-0">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                    {s.topCategory}
                  </span>
                  <span className="text-sm font-medium text-destructive">
                    {s.totalErrors} 处错误
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 弱项训练推荐：基于 weakCategories 算法的输出，展示 top 2 高频错误类别 */}
      {/* 仅在有推荐数据时渲染（weakCategories 非空） */}
      {weakCategories.length > 0 && (
        <div className="border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-4">弱项训练</h2>
          <p className="text-xs text-muted-foreground mb-4">
            基于最近 10 篇批改记录，系统推荐以下弱项进行专项训练
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {weakCategories.map((cat) => (
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

/**
 * 统计概览卡片组件。
 * 用于展示单个指标（如批改篇数、总错误数等）。
 *
 * @param icon - 左侧图标
 * @param label - 指标名称
 * @param value - 指标数值
 * @param sub - 可选的副文本（如进步百分比，显示为绿色）
 */
function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="border rounded-lg p-4 space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-green-600">{sub}</p>}
    </div>
  );
}
