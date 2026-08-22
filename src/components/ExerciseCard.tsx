/**
 * @module ExerciseCard
 * @description 练习题卡片组件，支持填空题（选择按钮）、改错题和重写题（文本输入），
 * 同时服务于 ExercisePage（交互模式）和 HistoryDetailPage（只读模式）。
 */

import { CheckCircle2, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { matchAnswer } from "@/lib/parse-utils";
import type { ExerciseQuestion } from "@/types";

/** 卡片边框/底色的对错 variant（回顾模式），收敛三元嵌套 */
const CARD_RESULT_VARIANT = {
  correct: "border-green-500/40 bg-green-500/5",
  wrong: "border-red-500/40 bg-red-500/5",
  none: "",
} as const;

/** 选项按钮的对错/选中样式 variant，收敛多层三元嵌套 */
const OPTION_RESULT_VARIANT = {
  /** 回顾模式下标为正确答案的选项 */
  answer: "border-green-500 bg-green-500/10 text-green-700 dark:text-green-300",
  /** 回顾模式下被用户选错的选项 */
  wrongSelected: "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400",
  /** 回顾模式下的其他选项 */
  other: "border-border/40 text-muted-foreground",
} as const;

/** 对/错文本颜色（结果区与只读答案共用） */
const TEXT_COLOR = {
  correct: "text-green-600 dark:text-green-400",
  wrong: "text-red-600 dark:text-red-400",
} as const;

/**
 * 练习题卡片组件 —— 同时服务于 ExercisePage（交互模式）和 HistoryDetailPage（只读模式）。
 *
 * 根据题目类型渲染不同的输入方式：
 * - fill（填空题）: 4 选 1 按钮组
 * - correct（改错题）/ rewrite（重写题）: 文本输入框或纯文本展示
 *
 * 交互模式（onAnswer 提供时）：
 * - fill: 可点击的选项按钮
 * - correct/rewrite: 可编辑的 Input 框
 * - showResult=true 时禁用交互并展示结果
 *
 * 只读模式（onAnswer 未提供时）：
 * - fill: 不可点击的选项 div
 * - correct/rewrite: 显示用户答案文本 + 正确答案（若答错）
 * - 始终展示结果
 */
interface ExerciseCardProps {
  /** 练习题数据（type、question、options、answer、explanation） */
  exercise: ExerciseQuestion;
  /** 题目序号（从 0 开始） */
  index: number;
  /** 用户当前答案（只读模式下从 history 记录读取） */
  userAnswer?: string;
  /** 答题回调（交互模式下提供，只读模式下省略） */
  onAnswer?: (index: number, answer: string) => void;
  /** 是否显示评判结果（正确/错误 + 正确答案 + 解析） */
  showResult: boolean;
  /** 外部传入的判分结果（省略时由组件内部调用 matchAnswer 计算） */
  correct?: boolean;
}

export function ExerciseCard({
  exercise,
  index,
  userAnswer = "",
  onAnswer,
  showResult,
  correct,
}: ExerciseCardProps) {
  // 回顾模式下使用 matchAnswer 按题型比对（fill 精确匹配，correct/rewrite 归一化匹配）
  // 若父组件传入 correct 则直接使用，否则自行计算
  const isCorrect = showResult
    ? (correct ?? matchAnswer(userAnswer, exercise.answer, exercise.type))
    : false;

  const interactive = !!onAnswer;

  return (
    // 回顾模式下卡片边框颜色反映对错：绿色=正确，红色=错误
    <div
      className={`rounded-lg border p-5 space-y-4 ${
        showResult
          ? isCorrect
            ? CARD_RESULT_VARIANT.correct
            : CARD_RESULT_VARIANT.wrong
          : CARD_RESULT_VARIANT.none
      }`}
    >
      {/* 题号 + 题目 */}
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
          {index + 1}
        </span>
        <p className="text-sm leading-relaxed">{exercise.question}</p>
      </div>

      {/* 填空题：2x2 网格选项 */}
      {exercise.type === "fill" && exercise.options && (
        <div className="grid grid-cols-2 gap-2 ml-9">
          {exercise.options.map((opt) => {
            const selected = userAnswer === opt;
            const isAnswer = showResult && opt === exercise.answer;
            const optionVariant = showResult
              ? isAnswer
                ? OPTION_RESULT_VARIANT.answer
                : selected
                  ? OPTION_RESULT_VARIANT.wrongSelected
                  : OPTION_RESULT_VARIANT.other
              : selected
                ? "border-primary bg-primary/10"
                : "border-border hover:border-primary/40 hover:bg-muted/50";
            return (
              <button
                key={opt}
                type="button"
                disabled={!interactive || showResult}
                onClick={interactive && !showResult ? () => onAnswer?.(index, opt) : undefined}
                aria-label={opt}
                aria-pressed={selected}
                className={`text-sm px-3 py-2 rounded-md border text-left transition-colors ${optionVariant} ${!interactive ? "cursor-default" : ""}`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      )}

      {/* 改错/重写题 */}
      {(exercise.type === "correct" || exercise.type === "rewrite") && (
        <div className="ml-9">
          {interactive ? (
            <Input
              value={userAnswer}
              onChange={(e) => onAnswer?.(index, e.target.value)}
              placeholder={
                exercise.type === "correct" ? "输入改正后的句子..." : "输入重写的句子..."
              }
              disabled={showResult}
              className="text-sm"
            />
          ) : (
            <div className="space-y-1">
              <p className="text-sm">
                <span className="text-muted-foreground">你的回答：</span>
                <span className={isCorrect ? TEXT_COLOR.correct : TEXT_COLOR.wrong}>
                  {userAnswer || "（未作答）"}
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* 回顾模式：显示结果 */}
      {showResult && (
        <div className="ml-9 space-y-2 pt-2 border-t border-border/40">
          <div className="flex items-center gap-2">
            {isCorrect ? (
              <CheckCircle2 className={`h-4 w-4 ${TEXT_COLOR.correct}`} />
            ) : (
              <XCircle className={`h-4 w-4 ${TEXT_COLOR.wrong}`} />
            )}
            <span
              className={`text-sm font-medium ${isCorrect ? TEXT_COLOR.correct : TEXT_COLOR.wrong}`}
            >
              {isCorrect ? "回答正确" : "回答错误"}
            </span>
          </div>
          {/* 交互模式下 Input 已展示用户答案，只读模式下已在上方展示，此处只在答错时显示正确答案 */}
          {!isCorrect && (
            <p className="text-sm">
              <span className="text-muted-foreground">正确答案：</span>
              <span className={`font-medium ${TEXT_COLOR.correct}`}>{exercise.answer}</span>
            </p>
          )}
          <p className="text-sm text-muted-foreground">{exercise.explanation}</p>
        </div>
      )}
    </div>
  );
}
