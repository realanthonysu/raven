/**
 * 级别进度卡片（Analytics 页）—— 分技能级别雷达 + 各技能估计明细 + 升级建议。
 *
 * 被动定级的展示层：数据来自 useAnalytics 编排层的 levelEstimates /
 * levelSuggestions（编排层内联 buildSkillEstimates 计算），本组件只负责渲染。
 * 雷达值 = 估计级别在 LEVEL_CODES 中的下标 + 1（A2=1 … C1=6），越外圈级别越高；
 * 建议为显式推荐（用户在 LevelCard 一键应用），本卡不直接改级别。
 */

import {
  ArrowDownCircle,
  ArrowUpCircle,
  Dumbbell,
  Gauge,
  type LucideIcon,
  TrendingUp,
} from "lucide-react";
import { memo, useMemo } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { HISTORY_RESULT_LIMIT } from "@/lib/db";
import {
  type EstimatableSkill,
  type EstimationConfidence,
  type LevelUpSuggestion,
  SKILL_LABELS,
  SKILL_ORDER,
  type SkillEstimate,
  type SuggestionKind,
} from "@/lib/level-estimation";
import { LEVEL_CODES, levelLabel } from "@/lib/levels";

/** 置信度中文标签 */
const CONFIDENCE_LABEL: Record<EstimationConfidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** 样本量的技能化单位（阅读/写作不是"练习"，用词更准确） */
const SAMPLE_UNIT: Record<EstimatableSkill, string> = {
  writing: "篇",
  reading: "次阅读",
  exercise: "次练习",
  listening: "次练习",
  speaking: "次练习",
};

/** 建议类型 → 图标 */
function suggestionIcon(kind: SuggestionKind): LucideIcon {
  switch (kind) {
    case "upgrade-global":
      return ArrowUpCircle;
    case "upgrade-skill":
      return TrendingUp;
    case "practice":
      return Dumbbell;
    case "downgrade-hint":
      return ArrowDownCircle;
  }
}

/** 置信度样式：low 弱化（半透明弱色调），其余正常 */
function confidenceClass(confidence: EstimationConfidence): string {
  return confidence === "low" ? "text-muted-foreground/60" : "text-muted-foreground";
}

/** recharts Tooltip formatter：把雷达值（1..6）映射回级别标签 */
function radarTooltipFormatter(value: unknown): [string, string] {
  const idx = typeof value === "number" ? value - 1 : -1;
  const code = LEVEL_CODES[idx];
  return code ? [levelLabel(code), "估计级别"] : ["—", "估计级别"];
}

/** LevelProgressCard 组件的 Props 接口 */
interface LevelProgressCardProps {
  /** 各技能级别估计（样本不足的技能不在其中） */
  estimates: SkillEstimate[];
  /** 升级建议（显式推荐） */
  suggestions: LevelUpSuggestion[];
  /** 详细结果窗口是否被 resultLimit 截断（为真时附窗口说明） */
  resultsWindowLimited?: boolean;
}

/**
 * 级别进度卡片。
 *
 * 无任何估计（样本不足）时整卡显示引导空态；有估计时展示雷达图、五技能
 * 明细行（无估计的技能标注"样本不足"）与建议列表。
 *
 * memo：AnalyticsPage 的 days 切换/错题本展开等局部状态变化不应重渲染本卡；
 * 派生 Map 与雷达数据用 useMemo 固定引用（H-03/P-08）。
 */
export const LevelProgressCard = memo(function LevelProgressCard({
  estimates,
  suggestions,
  resultsWindowLimited = false,
}: LevelProgressCardProps) {
  const { level } = useProficiencyLevel();

  const estimateBySkill = useMemo(() => new Map(estimates.map((e) => [e.skill, e])), [estimates]);

  // 雷达数据：仅纳入有估计的技能（无估计的技能不画点，避免误导为"级别 0"）
  const radarData = useMemo(
    () =>
      SKILL_ORDER.flatMap((skill) => {
        const estimate = estimateBySkill.get(skill);
        return estimate
          ? [{ skill: SKILL_LABELS[skill], value: LEVEL_CODES.indexOf(estimate.level) + 1 }]
          : [];
      }),
    [estimateBySkill],
  );

  return (
    <div className="border rounded-lg p-4">
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Gauge className="h-4 w-4" />
        级别进度
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        基于练习表现被动估计的各技能级别 · 当前级别 {levelLabel(level)}
      </p>

      {estimates.length === 0 ? (
        // 样本不足：引导空态
        <p className="text-sm text-muted-foreground py-6 text-center">
          完成几次练习后，这里会基于你的表现估计各技能级别
        </p>
      ) : (
        <>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart outerRadius={90} data={radarData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="skill" tick={{ fontSize: 13 }} />
                <PolarRadiusAxis angle={90} domain={[0, 6]} tick={{ fontSize: 10 }} tickCount={7} />
                <Radar
                  name="估计级别"
                  dataKey="value"
                  stroke="#8884d8"
                  fill="#8884d8"
                  fillOpacity={0.3}
                  strokeWidth={2}
                />
                <Tooltip formatter={radarTooltipFormatter} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* 技能明细：固定五技能，无估计者标注样本不足 */}
          <div className="mt-4">
            {SKILL_ORDER.map((skill) => {
              const est = estimateBySkill.get(skill);
              return (
                <div
                  key={skill}
                  className="flex items-center justify-between py-1.5 border-b last:border-0"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm">{SKILL_LABELS[skill]}</span>
                    {est ? (
                      <>
                        <Badge variant="secondary">{est.level}</Badge>
                        <span className={`text-xs ${confidenceClass(est.confidence)}`}>
                          置信度 {CONFIDENCE_LABEL[est.confidence]}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">样本不足</span>
                    )}
                  </div>
                  {est && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {est.sampleSize} {SAMPLE_UNIT[skill]}
                      {est.avgScore !== null && ` · 均分 ${Math.round(est.avgScore)}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 升级建议：显式推荐（应用入口在 LevelCard） */}
      {suggestions.length > 0 && (
        <div className="mt-4 pt-3 border-t space-y-2">
          {suggestions.map((s) => {
            const Icon = suggestionIcon(s.kind);
            const neutral = s.kind === "downgrade-hint";
            return (
              // kind + skill 唯一（upgrade-skill 的技能各不相同，整体/降档建议无 skill），
              // 用业务键替代数组下标，建议列表重排时不误复用 DOM
              <div
                key={`${s.kind}-${s.skill ?? "global"}`}
                className="flex items-start gap-2 text-sm"
              >
                <Icon
                  className={`h-4 w-4 mt-0.5 shrink-0 ${
                    neutral ? "text-muted-foreground" : "text-primary"
                  }`}
                />
                <span className="flex-1">{s.text}</span>
                <Badge variant="outline" className="shrink-0">
                  {s.targetLevel}
                </Badge>
              </div>
            );
          })}
        </div>
      )}

      {resultsWindowLimited && (
        <p className="text-xs text-muted-foreground mt-3">
          级别估计基于最近 {HISTORY_RESULT_LIMIT} 条记录的详细结果
        </p>
      )}
    </div>
  );
});
