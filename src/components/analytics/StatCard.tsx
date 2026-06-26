/**
 * 统计概览卡片组件。
 * 用于 AnalyticsPage 展示单个指标（如批改篇数、总错误数等）。
 */

/** StatCard 组件的 Props 接口 */
interface StatCardProps {
  /** 标题左侧的图标，使用 lucide-react 图标组件 */
  icon: React.ReactNode;
  /** 指标标签文本（如"批改篇数"） */
  label: string;
  /** 指标的主数值（如"128"） */
  value: string;
  /** 可选的补充说明文本（如"本周 +12"） */
  sub?: string;
  /** 补充说明的颜色 CSS 类名，默认为绿色 */
  subColor?: string;
}

/**
 * 统计概览卡片组件
 *
 * @param props - 组件属性
 * @param props.icon - 标题左侧图标
 * @param props.label - 指标标签
 * @param props.value - 主数值
 * @param props.sub - 可选的补充说明
 * @param props.subColor - 补充说明的颜色类名
 * @returns 卡片 JSX 元素
 */
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
