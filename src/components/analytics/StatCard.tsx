/**
 * 统计概览卡片组件。
 * 用于 AnalyticsPage 展示单个指标（如批改篇数、总错误数等）。
 */

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  subColor?: string;
}

export function StatCard({ icon, label, value, sub, subColor }: StatCardProps) {
  return (
    <div className="border rounded-lg p-4 space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {sub && <p className={`text-xs ${subColor ?? "text-green-600"}`}>{sub}</p>}
    </div>
  );
}
