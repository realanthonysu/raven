/**
 * @module placement/PlacementTestDialog
 * @description AI 定级测试对话框（Track A）—— intro → testing → result 三阶段向导。
 *
 * - intro：说明测试形式（约 12 题、5 分钟、覆盖 A2–C1）；「开始测试」触发
 *   usePlacementTest.generate()（LLM 一次性命题），生成中展示 loading，
 *   失败展示错误与重试。
 * - testing：一次一题，原生 radio 选项（模式同 onboarding/StepSelectLevel）；
 *   进度「第 n/N 题」；未答可跳过（提交计分时按错误处理）；最后一题提交，
 *   提交在途按钮禁用并转圈，迟到结果被 reset 作废时不进入 result。
 * - result：估计级别大徽章（levelLabel）+ 各档正确率条形 + 答对总数；
 *   「应用为当前级别」经 setLevelGlobal 写全局 store 后关闭，「仅保存」直接
 *   关闭（结果已在 submit 时持久化到 settings 的 placement_result 键）；
 *   持久化失败时展示 saveError 与「重试保存」。
 *
 * 关闭（含 Esc/遮罩/X）统一走 handleOpenChange：abort 在途命题请求并复位到
 * intro，下次打开是一次全新测试。
 * 焦点管理：phase 切换后聚焦该阶段主按钮（testing=下一题/提交，
 * result=应用为当前级别），键盘用户可直接回车推进，不用 Tab 找按钮。
 */

import { Loader2, Sparkles } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { usePlacementTest } from "@/hooks/use-placement-test";
import type { PlacementScore } from "@/lib/level-estimation";
import { levelLabel } from "@/lib/levels";
import type { PlacementQuestion } from "@/lib/schemas";

/** 向导阶段 */
type PlacementPhase = "intro" | "testing" | "result";

/** 各阶段的副标题文案 */
const PHASE_DESCRIPTIONS: Record<PlacementPhase, string> = {
  intro: "通过 12 道递增难度的单选题，估计你的英语水平级别。",
  testing: "选择每题最恰当的选项；未作答的题目按错误计算。",
  result: "根据各档正确率估计你的英语水平级别，可一键应用为当前级别。",
};

interface PlacementTestDialogProps {
  /** 对话框是否打开（受控） */
  open: boolean;
  /** 开关状态变化回调（关闭时内部会先做复位） */
  onOpenChange: (open: boolean) => void;
  /** 对话框收尾后回调 —— 调用方刷新「上次测试」结果行 */
  onCompleted?: () => void;
}

export function PlacementTestDialog({ open, onOpenChange, onCompleted }: PlacementTestDialogProps) {
  const {
    questions,
    answers,
    score,
    generating,
    submitting,
    error,
    saveError,
    generate,
    setAnswer,
    submit,
    retrySave,
    applyResult,
    reset,
  } = usePlacementTest();
  // 当前题号（testing 阶段内部状态；每次进入 testing 归零，见 onEnter）
  const [current, setCurrent] = useState(0);
  // 各阶段主按钮：phase 切换后聚焦（键盘用户可直接推进，不用 Tab 找按钮）
  const testingPrimaryRef = useRef<HTMLButtonElement>(null);
  const resultPrimaryRef = useRef<HTMLButtonElement>(null);

  const { phase, transition, isPhase } = usePhaseMachine<PlacementPhase>("intro", {
    onEnter: { testing: () => setCurrent(0) },
  });

  // 焦点跟随阶段切换：不在每次渲染抢焦点，只在 phase 变化时聚焦对应主按钮
  useEffect(() => {
    if (phase === "testing") {
      testingPrimaryRef.current?.focus();
    } else if (phase === "result") {
      resultPrimaryRef.current?.focus();
    }
  }, [phase]);

  /** 开始测试：生成题目，有有效题才进入答题阶段 */
  async function handleStart() {
    const ok = await generate();
    if (ok) transition("testing");
  }

  /** 下一题；最后一题变为提交：计分持久化后进入结果阶段。
   *  submit 返回 null（无题 / 在途被 reset 作废）时留在 testing，不进 result。 */
  async function handleNext() {
    if (current < questions.length - 1) {
      setCurrent((c) => c + 1);
      return;
    }
    const s = await submit();
    if (s) transition("result");
  }

  function handlePrev() {
    setCurrent((c) => Math.max(0, c - 1));
  }

  /** 应用为当前级别：写全局 store（write-through）后关闭 */
  function handleApply() {
    applyResult();
    handleClose();
  }

  /** 仅保存：结果已在 submit 时持久化，直接关闭 */
  function handleSaveOnly() {
    handleClose();
  }

  /** 收尾关闭：复位（abort 在途请求）→ 回到 intro → 通知调用方刷新 */
  function handleClose() {
    reset();
    // 走 transition 而非 setPhase：关闭是一次常规阶段收尾（intro→testing→result→intro），
    // setPhase 仅保留给错误恢复场景绕过 onExit/onEnter；本组件 intro 无阶段回调，
    // 且 transition 对 current===next 早退，与直接置位行为等价
    transition("intro");
    onCompleted?.();
    onOpenChange(false);
  }

  /** 受控开关：关闭走完整收尾；打开直接透传（状态已在关闭时复位） */
  function handleOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    handleClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>AI 定级测试</DialogTitle>
          <DialogDescription>{PHASE_DESCRIPTIONS[phase]}</DialogDescription>
        </DialogHeader>

        {isPhase("intro") && (
          <PlacementIntro generating={generating} error={error} onStart={handleStart} />
        )}

        {isPhase("testing") && questions[current] && (
          <PlacementQuestionView
            question={questions[current]}
            index={current}
            total={questions.length}
            selected={answers[current] ?? null}
            submitting={submitting}
            primaryRef={testingPrimaryRef}
            onSelect={(option) => setAnswer(current, option)}
            onPrev={handlePrev}
            onNext={handleNext}
          />
        )}

        {isPhase("result") && score && (
          <PlacementResultView
            score={score}
            saveError={saveError}
            primaryRef={resultPrimaryRef}
            onApply={handleApply}
            onSaveOnly={handleSaveOnly}
            onRetrySave={retrySave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── intro ────────────────────────────────────────────────────────────

interface PlacementIntroProps {
  generating: boolean;
  error: string | null;
  onStart: () => void;
}

function PlacementIntro({ generating, error, onStart }: PlacementIntroProps) {
  return (
    <div className="space-y-4">
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        <li>· 约 12 道单选题，覆盖 A2–C1 六个级别档，难度递增</li>
        <li>· 题型包括词汇选择、语法填空与语境填空</li>
        <li>· 约 5 分钟完成；测试结束后自动估计你的级别</li>
        <li>· 未作答的题目按错误计算，请尽量答完每一题</li>
      </ul>

      {generating ? (
        <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在生成测试题…
        </div>
      ) : (
        <Button type="button" className="w-full" onClick={onStart}>
          <Sparkles className="h-4 w-4 mr-1" />
          开始测试
        </Button>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <Button type="button" variant="outline" className="w-full" onClick={onStart}>
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

// ── testing ──────────────────────────────────────────────────────────

interface PlacementQuestionViewProps {
  question: PlacementQuestion;
  /** 当前题号（0 起） */
  index: number;
  /** 总题数 */
  total: number;
  /** 当前题已选选项（null = 未答） */
  selected: string | null;
  /** 提交在途：主按钮禁用并转圈，防止连点重复计分落库 */
  submitting: boolean;
  /** 主按钮 ref（phase 切换后聚焦用） */
  primaryRef: RefObject<HTMLButtonElement | null>;
  onSelect: (option: string) => void;
  onPrev: () => void;
  onNext: () => void;
}

function PlacementQuestionView({
  question,
  index,
  total,
  selected,
  submitting,
  primaryRef,
  onSelect,
  onPrev,
  onNext,
}: PlacementQuestionViewProps) {
  const isLast = index === total - 1;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          第 {index + 1} / {total} 题
        </span>
        <Badge variant="secondary">{question.band}</Badge>
      </div>

      <p className="text-sm font-medium">{question.question}</p>

      {/* 原生 radio 组：name 按题号隔离保证同题选项互斥（模式同 StepSelectLevel） */}
      <div role="radiogroup" aria-label="选项" className="space-y-1.5">
        {question.options.map((option) => {
          const checked = selected === option;
          return (
            <label
              key={option}
              className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                checked ? "border-primary bg-primary/5" : "hover:bg-accent"
              }`}
            >
              <input
                type="radio"
                name={`placement-question-${index}`}
                value={option}
                checked={checked}
                onChange={() => onSelect(option)}
                className="h-4 w-4 shrink-0"
              />
              <span>{option}</span>
            </label>
          );
        })}
      </div>

      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onPrev} disabled={index === 0}>
          上一题
        </Button>
        <Button type="button" ref={primaryRef} onClick={onNext} disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {isLast ? "提交" : "下一题"}
        </Button>
      </div>
    </div>
  );
}

// ── result ───────────────────────────────────────────────────────────

interface PlacementResultViewProps {
  score: PlacementScore;
  /** 结果持久化失败信息（非 null 时展示重试入口） */
  saveError: string | null;
  /** 主按钮 ref（phase 切换后聚焦用） */
  primaryRef: RefObject<HTMLButtonElement | null>;
  onApply: () => void;
  onSaveOnly: () => void;
  onRetrySave: () => void;
}

function PlacementResultView({
  score,
  saveError,
  primaryRef,
  onApply,
  onSaveOnly,
  onRetrySave,
}: PlacementResultViewProps) {
  return (
    <div className="space-y-4">
      {/* 估计级别大徽章 */}
      <div className="flex flex-col items-center gap-1.5 py-1">
        <span className="rounded-full bg-primary px-4 py-1.5 text-lg font-semibold text-primary-foreground">
          {levelLabel(score.estimated)}
        </span>
        <span className="text-xs text-muted-foreground">
          答对 {score.totalCorrect} / {score.totalCount} 题
        </span>
      </div>

      {/* 各档正确率小条形 */}
      <div className="space-y-1.5">
        {score.perBand.map((band) => (
          <div key={band.band} className="flex items-center gap-2 text-xs">
            <span className="w-8 shrink-0 font-medium">{band.band}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${(band.correct / band.total) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right text-muted-foreground">
              {band.correct}/{band.total}
            </span>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        计分规则：从低档到高档累计正确率达到 60% 即认定该档达标，估计级别取最高达标档。
      </p>

      {/* 持久化失败：结果仍展示，保存可重试（重启前不丢失） */}
      {saveError && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-destructive">{saveError}</span>
          <Button type="button" size="sm" variant="outline" onClick={onRetrySave}>
            重试保存
          </Button>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" ref={primaryRef} className="flex-1" onClick={onApply}>
          应用为当前级别
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={onSaveOnly}>
          仅保存
        </Button>
      </div>
    </div>
  );
}
