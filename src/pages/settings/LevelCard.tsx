/**
 * 英语水平定级卡片 —— CEFR 级别尺子（考试锚点双标注），全应用内容难度的单一开关。
 *
 * 内部存储 CEFR 码（A2..C1），界面以中国考试锚点（中考/高考/四六级/专四专八）
 * 双标注：用户按自己认得的考试选级，落库为 CEFR 码（见 lib/levels.ts）。
 * 阅读精读、弱项训练等 LLM 功能按当前级别生成内容。
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { LEVEL_SURVEY_OPTIONS, levelLabel } from "@/lib/levels";

/**
 * 英语水平定级卡片。
 *
 * 读写均走全局 store（useProficiencyLevel，单一数据源是 settings 表的
 * proficiency_level 键）：选择即生效并持久化，无需保存按钮。
 */
export function LevelCard() {
  const { level, setLevel } = useProficiencyLevel();

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

        <p className="text-xs text-muted-foreground">
          随时可改，新生成的内容立即按新级别执行；历史记录保留生成时的级别。
        </p>
      </CardContent>
    </Card>
  );
}
