/**
 * @module ExercisePage
 * @description 弱项训练页面。
 *
 * 针对用户写作中暴露出的薄弱错误类别，生成专项练习题进行强化训练。
 * 三阶段状态机流程：
 * 1. loading — 调用 LLM 基于类别 + 个性化上下文生成 5 道练习题
 * 2. answering — 用户逐题作答（填空/改写等题型）
 * 3. review — 统一判分，展示对错、正确答案和解析，并持久化到 history 表
 *
 * 主要特性：
 * - 30 秒超时提示（useRetryHint）
 * - 个性化 prompt：注入用户近期错误历史
 * - 结果持久化：ExerciseResult JSON 写入 history 表供 HistoryDetailPage 回顾
 */

import { ArrowLeft, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { ExerciseCard } from "@/components/ExerciseCard";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { ErrorBanner, LoadingIndicator, RetryHint, WarningBanner } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { buildPersonalizedContext } from "@/lib/db";
import { extractJson, matchAnswer } from "@/lib/parse-utils";
import { ExerciseQuestionSchema } from "@/lib/schemas";
import { buildExercisePrompt } from "@/prompts";
import type { ExerciseQuestion, ExerciseResult } from "@/types";
import { exerciseReducer, initialExerciseState } from "./exercise-reducer";

/** 练习流程的三个阶段：生成中 → 答题中 → 回顾 */
type Phase = "loading" | "answering" | "review";

/**
 * Zod schema for validating LLM-generated exercise response.
 * 仅校验生成阶段的 { exercises: [...] } 结构，与 ExerciseResultSchema（完整结果）区分。
 */
const ExerciseGenerationSchema = z.object({
  exercises: z.array(ExerciseQuestionSchema),
});

/**
 * 练习页面（ExercisePage）。
 *
 * 三阶段流程：
 * 1. loading — 调用 LLM 生成 5 道练习题
 * 2. answering — 用户逐题作答（填空/输入）
 * 3. review — 展示所有题目的对错、正确答案和解析
 *
 * 完成后将结果持久化到 history 表（type="exercise"）。
 */
export default function ExercisePage() {
  const { category } = useParams<{ category: string }>();
  const navigate = useNavigate();

  // --- 辅助 UI 状态（在 phase machine 之前声明，供 onEnter 回调引用） ---
  // useReducer 集中管理关联状态，替代多个分散的 useState
  const [state, dispatch] = useReducer(exerciseReducer, initialExerciseState);
  const { exercises, userAnswers, score, error, saveError } = state;

  // --- 核心流程状态机 ---
  const { transition, isPhase } = usePhaseMachine<Phase>("loading", {
    onEnter: {
      loading: () => {
        dispatch({ type: "RESET" });
      },
    },
  });

  // URL 参数解码：category 可能包含中文（如"时态错误"），需要 decodeURIComponent
  const decodedCategory = category ? decodeURIComponent(category) : "";

  // --- LLM 流式调用 hook（autoPersist: false，用户提交答案后手动持久化） ---
  const [isGenerating, setIsGenerating] = useState(false);
  // 存储用户提交后的完整练习结果（含答案和分数），供 buildHistoryRecord 在 persistResult 时读取
  const exerciseResultRef = useRef<string>("");
  const { handleSubmit, abort, persistResult } = useLLMStreamPage({
    activityType: "exercise",
    autoPersist: false,
    buildMessages: async () => {
      const context = await buildPersonalizedContext(10);
      return [buildExercisePrompt(decodedCategory, context || undefined), ""];
    },
    buildHistoryRecord: () => ({
      type: "exercise",
      input_text: decodedCategory,
      result: exerciseResultRef.current,
    }),
    onDone: (fullText) => {
      try {
        const parsed = extractJson<{ exercises: ExerciseQuestion[] }>(
          fullText,
          (d): d is { exercises: ExerciseQuestion[] } =>
            ExerciseGenerationSchema.safeParse(d).success,
        );
        if (!parsed) throw new Error("parse failed");
        dispatch({
          type: "SET_EXERCISES",
          exercises: parsed.exercises,
          answers: new Array(parsed.exercises.length).fill(""),
        });
        transition("answering");
      } catch {
        dispatch({ type: "SET_ERROR", error: "解析练习题失败，请重试。" });
      }
    },
    onError: (err) => {
      dispatch({ type: "SET_ERROR", error: `生成失败：${err.message}` });
    },
  });

  // 30 秒超时提示：加载超过 30 秒后显示"重新生成"建议
  const { showRetryHint } = useRetryHint(isGenerating);

  /** 调用 LLM 生成练习题 */
  const generateExercises = useCallback(async () => {
    setIsGenerating(true);
    try {
      await handleSubmit("");
    } finally {
      setIsGenerating(false);
    }
  }, [handleSubmit]);

  /** 挂载时调用 LLM 生成练习题 */
  useEffect(() => {
    if (!decodedCategory) return;

    abort();
    generateExercises();
    return () => abort();
  }, [decodedCategory, generateExercises, abort]);

  /** 更新某题的用户答案 */
  function setAnswer(index: number, value: string) {
    dispatch({ type: "SET_ANSWER", index, value });
  }

  /**
   * 提交所有答案，进入回顾阶段。
   *
   * 流程：
   * 1. 切换到 review 阶段（UI 立即响应，不等 DB 写入）
   * 2. 按题型调用 matchAnswer 计算得分（fill 精确匹配，correct/rewrite 归一化匹配）
   * 3. 构造 ExerciseResult JSON 并持久化到 history 表
   * 4. 若 DB 写入失败，设置 saveError 警告（不阻塞回顾体验）
   */
  async function handleSubmitAnswers() {
    transition("review");

    // 逐题判分：matchAnswer 根据题型采用不同的比对策略
    const computedScore = exercises.reduce(
      (sum, ex, i) => sum + (matchAnswer(userAnswers[i] ?? "", ex.answer, ex.type) ? 1 : 0),
      0,
    );
    // 存入 state，供 UI 显示和 handleRetry 重置
    dispatch({ type: "SET_SCORE", score: computedScore });

    // 持久化练习结果，供 HistoryDetailPage 回顾时读取
    const result: ExerciseResult = {
      category: decodedCategory,
      exercises,
      userAnswers,
      score: computedScore,
    };
    // 写入 ref 供 buildHistoryRecord 在 persistResult 时读取
    exerciseResultRef.current = JSON.stringify(result);
    const historyId = await persistResult();
    if (historyId === null) {
      dispatch({
        type: "SET_SAVE_ERROR",
        error: "练习结果保存失败",
      });
    }
  }

  /**
   * 重新生成练习题。
   *
   * 调用时机：
   * - 回顾阶段点击"再来一轮"按钮
   * - 加载超时提示中点击"重新生成"
   *
   * 关键步骤：
   * 1. 重置所有状态回初始值
   * 2. abort 掉旧的 AbortController（取消进行中的请求）
   * 3. 创建新的 AbortController 并存入 ref
   * 4. 调用共享的 generateExercises 生成新题目
   *
   * 注意：必须在调用 generateExercises 之前创建新 controller，
   * 否则 generateExercises 内的 streamChat 会拿到已 abort 的 signal。
   */
  function handleRetry() {
    transition("loading");
    abort();
    generateExercises();
  }

  // 未指定类别时的降级
  if (!decodedCategory) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          返回学习分析
        </Button>
        <p className="text-muted-foreground text-center py-12">未指定训练类别。</p>
      </div>
    );
  }

  // === 阶段一：生成中 ===
  // 居中显示加载动画 + 类别标题，LLM 响应期间用户看到此界面
  // 生成失败时也停留在此阶段（isGenerating 已为 false），显示错误和重试按钮
  if (isGenerating || isPhase("loading")) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
          <h2 className="text-xl font-bold">弱项训练：{decodedCategory}</h2>
        </div>
        {error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <ErrorBanner message={error} />
            <Button onClick={handleRetry}>
              <RotateCcw className="h-4 w-4 mr-2" />
              重新生成
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <LoadingIndicator text="正在生成针对性练习题..." className="h-auto" />
            {/* 超时提示：30 秒后显示，由 showRetryHint useEffect 控制 */}
            <RetryHint show={showRetryHint} onRetry={handleRetry} />
          </div>
        )}
      </div>
    );
  }

  // === 阶段二 & 三：答题 / 回顾 ===
  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
          <h2 className="text-xl font-bold">弱项训练：{decodedCategory}</h2>
        </div>
        {isPhase("review") && (
          <span className="text-sm font-medium text-muted-foreground">
            得分：{score}/{exercises.length}
          </span>
        )}
      </div>

      {/* 错误提示 */}
      {error && <ErrorBanner message={error} />}

      {/* 保存失败警告 */}
      {saveError && isPhase("review") && <WarningBanner message={saveError} />}

      {/* 题目列表 */}
      {exercises.length > 0 && (
        <InlineErrorBoundary sectionName="exercises">
          <div className="space-y-6">
            {exercises.map((ex, i) => (
              <ExerciseCard
                // biome-ignore lint/suspicious/noArrayIndexKey: exercises list is static (never reordered)
                key={`${ex.type}-${i}`}
                index={i}
                exercise={ex}
                userAnswer={userAnswers[i] ?? ""}
                onAnswer={(_idx, v) => setAnswer(i, v)}
                showResult={isPhase("review")}
              />
            ))}
          </div>
        </InlineErrorBoundary>
      )}

      {/* 底部操作栏 */}
      {exercises.length > 0 && isPhase("answering") && (
        <div className="flex justify-center pt-4">
          <Button
            size="lg"
            onClick={handleSubmitAnswers}
            disabled={userAnswers.every((a) => !a.trim())}
          >
            提交答案
          </Button>
        </div>
      )}

      {/* 回顾阶段的操作栏 */}
      {isPhase("review") && (
        <div className="flex justify-center gap-3 pt-4">
          <Button variant="outline" onClick={handleRetry}>
            再来一轮
          </Button>
          <Button onClick={() => navigate("/analytics")}>返回学习分析</Button>
        </div>
      )}
    </div>
  );
}
