/**
 * 英语水平定级卡片 —— CEFR 级别尺子（考试锚点双标注），全应用内容难度的单一开关。
 *
 * 内部存储 CEFR 码（A2..C1），界面以中国考试锚点（中考/高考/四六级/专四专八）
 * 双标注：用户按自己认得的考试选级，落库为 CEFR 码（见 lib/levels.ts）。
 * 阅读精读、弱项训练等 LLM 功能按当前级别生成内容。
 */

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PlacementTestDialog } from "@/components/placement/PlacementTestDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLevelEstimation } from "@/hooks/use-level-estimation";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { getPlacementResult } from "@/lib/db/settings";
import { type EstimatableSkill, SKILL_LABELS } from "@/lib/level-estimation";
import { isLevelCode, LEVEL_SURVEY_OPTIONS, levelLabel } from "@/lib/levels";
import type { PlacementResult } from "@/lib/schemas";

/** 被动估计徽章行的固定技能顺序 */
const SKILL_ORDER: EstimatableSkill[] = ["writing", "reading", "exercise", "listening", "speaking"];

/**
 * 英语水平定级卡片。
 *
 * 读写均走全局 store（useProficiencyLevel，单一数据源是 settings 表的
 * proficiency_level 键）：选择即生效并持久化，无需保存按钮。
 */
export function LevelCard() {
  const { level, setLevel } = useProficiencyLevel();
  const { estimates, suggestions, loading, refresh } = useLevelEstimation();

  // ── AI 定级测试（Track A）：对话框开关 + 最近一次测试结果行 ──
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementResult, setPlacementResult] = useState<PlacementResult | null>(null);

  // 挂载时与对话框收尾后刷新（fail-soft：读取失败/无记录时不显示该行）
  const refreshPlacementResult = useCallback(() => {
    getPlacementResult()
      .then((result) => setPlacementResult(result ?? null))
      .catch(() => {
        /* 读取失败静默：结果行不显示，不影响定级选项 */
      });
  }, []);
  useEffect(() => {
    refreshPlacementResult();
  }, [refreshPlacementResult]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>英语水平定级</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          采用 CEFR
          国际标准（A2–C1）并以中国考试锚点双标注。阅读精读、弱项训练等内容会按当前级别调整难度。
        </p>

        {/* 当前级别：选中选项后即时更新为对应 CEFR 级别标签 */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">当前级别</span>
          <Badge variant="secondary">{levelLabel(level)}</Badge>
        </div>

        {/* 定级选项：按考试/学段分组，选中项高亮 */}
        <div className="grid grid-cols-2 gap-2">
          {LEVEL_SURVEY_OPTIONS.map((option) => (
            <Button
              key={option.label}
              type="button"
              variant={level === option.code ? "default" : "outline"}
              size="sm"
              className="justify-start font-normal"
              onClick={() => setLevel(option.code)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        {/* === 被动估计：基于练习表现估计各技能级别；建议需手动应用，不自动调级 === */}
        <div className="border-t pt-3 space-y-3">
          <div>
            <p className="text-sm font-medium">被动估计</p>
            <p className="text-xs text-muted-foreground">
              根据你的练习表现估计的各技能级别。建议需你手动应用，不会自动调整级别。
            </p>
          </div>

          {loading ? (
            <p className="text-xs text-muted-foreground">正在估计…</p>
          ) : estimates.length === 0 ? (
            <p className="text-xs text-muted-foreground">练习数据不足，暂无法估计级别。</p>
          ) : (
            <div className="grid grid-cols-5 gap-2">
              {SKILL_ORDER.map((skill) => {
                const est = estimates.find((e) => e.skill === skill);
                return (
                  <div key={skill} className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground">{SKILL_LABELS[skill]}</span>
                    {est ? (
                      <Badge
                        variant="secondary"
                        className={est.confidence === "low" ? "opacity-50" : undefined}
                      >
                        {est.level}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!loading && suggestions.length > 0 && (
            <div className="space-y-2">
              {suggestions.map((s) => {
                const neutral = s.kind === "downgrade-hint";
                return (
                  <div key={`${s.kind}-${s.skill ?? "global"}`} className="flex items-center gap-2">
                    <span className={`text-sm flex-1 ${neutral ? "text-muted-foreground" : ""}`}>
                      {s.text}
                    </span>
                    <Button
                      size="sm"
                      variant={neutral ? "outline" : "default"}
                      onClick={() => {
                        setLevel(s.targetLevel);
                        refresh();
                      }}
                    >
                      应用
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* === AI 定级测试：LLM 生成 12 道六档单选题，本地规则计分估计级别 === */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">AI 定级测试</p>
              <p className="text-xs text-muted-foreground">约 12 题 · 5 分钟 · 覆盖 A2–C1</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPlacementOpen(true)}
            >
              <Sparkles className="h-4 w-4 mr-1" />
              AI 定级测试
            </Button>
          </div>
          {placementResult && (
            <p className="text-xs text-muted-foreground">{formatPlacementRow(placementResult)}</p>
          )}
        </div>

        <PlacementTestDialog
          open={placementOpen}
          onOpenChange={setPlacementOpen}
          onCompleted={refreshPlacementResult}
        />

        <p className="text-xs text-muted-foreground">
          随时可改，新生成的内容立即按新级别执行；历史记录保留生成时的级别。
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * 「上次测试」结果行文案：上次测试：B2（≈大学六级 CET-6）· 10-19 · 答对 9/12。
 *
 * estimated_level 在 schema 中是宽松 string，非法值原样展示（isLevelCode 兜底）。
 * 答对数优先取 total_correct；旧结果（本字段上线前保存）缺失时，
 * 按「各档题数均衡」从 per_band（0-1 正确率小数）还原——
 * 命题规格为 6 档 × 2 题，无效题过滤造成档间题数不均时存在四舍五入误差。
 */
function formatPlacementRow(result: PlacementResult): string {
  const level = isLevelCode(result.estimated_level)
    ? levelLabel(result.estimated_level)
    : result.estimated_level;
  const testedAt = new Date(result.tested_at);
  const mmdd = Number.isNaN(testedAt.getTime())
    ? "--"
    : `${String(testedAt.getMonth() + 1).padStart(2, "0")}-${String(testedAt.getDate()).padStart(2, "0")}`;
  const bands = Object.keys(result.per_band);
  const perBandTotal = bands.length > 0 ? result.question_count / bands.length : 0;
  const correct =
    result.total_correct ??
    Math.round(bands.reduce((sum, band) => sum + result.per_band[band] * perBandTotal, 0));
  return `上次测试：${level} · ${mmdd} · 答对 ${correct}/${result.question_count}`;
}
