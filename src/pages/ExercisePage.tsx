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
 * - 难度适配：按用户 CEFR 级别（getProficiencyLevel）命制题目，级别徽章展示在标题旁
 * - 结果持久化：ExerciseResult JSON 写入 history 表供 HistoryDetailPage 回顾
 */

import { ArrowLeft, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { ExerciseCard } from "@/components/ExerciseCard";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { ErrorBanner, LoadingIndicator, RetryHint, WarningBanner } from "@/components/page-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { usePracticeSession } from "@/hooks/use-practice-session";
import { useProficiencyLevel } from "@/hooks/use-proficiency-level";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { buildPersonalizedContext, getProficiencyLevel } from "@/lib/db";
import { type LevelCode, levelLabel } from "@/lib/levels";
import { matchAnswer } from "@/lib/parse-utils";
import { ExerciseQuestionSchema, makeListEnvelope } from "@/lib/schemas";
import { buildExercisePrompt } from "@/prompts";
import type { ExerciseResult } from "@/types";
import { exerciseReducer, initialExerciseState } from "./exercise-reducer";

/** 练习流程的三个阶段：生成中 → 答题中 → 回顾 */
type Phase = "loading" | "answering" | "review";

/**
 * Zod schema for validating LLM-generated exercise response.
 * 仅校验生成阶段的 { exercises: [...] } 结构，与 ExerciseResultSchema（完整结果）区分。
 */
const ExerciseGenerationSchema = makeListEnvelope("exercises", ExerciseQuestionSchema);

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

  // 稳定身份：ExerciseCard 经 memo 后，内联箭头函数会击穿 memo（5 张卡互相拖累）
  const handleAnswer = useCallback((index: number, answer: string) => {
    dispatch({ type: "SET_ANSWER", index, value: answer });
  }, []);

  // --- 核心流程状态机 ---
  const { transition, isPhase } = usePhaseMachine<Phase>("loading", {
    onEnter: {
      loading: () => {
        dispatch({ type: "RESET" });
      },
    },
  });

  // react-router 的 useParams 已对 URL 参数做过一次解码，直接使用即可。
  // （此前再套一层 decodeURIComponent 属双重解码：类别名含 "%" 会抛 URIError
  // 直接崩页，含 "%xx" 字面量时被静默改写）
  const decodedCategory = category ?? "";

  // --- 当前英语水平级别（全局 store，标题旁徽章展示） ---
  const { level } = useProficiencyLevel();

  // --- 练习会话（生成 → 解析 → 持久化的编排在 usePracticeSession 内） ---

  // 最近一次生成使用的 CEFR 级别：buildMessages 异步读取后写入，
  // 供 session 的 getDifficultyLevel 在持久化时快照（difficulty_level 由底层 hook 合并补入）
  const lastLevelRef = useRef<LevelCode | null>(null);
  const {
    isGenerating,
    generate: generateExercises,
    abort,
    persistWithResult,
  } = usePracticeSession({
    activityType: "exercise",
    schema: ExerciseGenerationSchema,
    buildMessages: async () => {
      const context = await buildPersonalizedContext(10);
      const level = await getProficiencyLevel();
      lastLevelRef.current = level;
      return [buildExercisePrompt(decodedCategory, context || undefined, 5, level), ""];
    },
    getDifficultyLevel: () => lastLevelRef.current,
    onParsed: (data) => {
      dispatch({
        type: "SET_EXERCISES",
        exercises: data.exercises,
        answers: new Array(data.exercises.length).fill(""),
      });
      transition("answering");
    },
    reportError: (message) => dispatch({ type: "SET_ERROR", error: message }),
    parseErrorMessage: "解析练习题失败，请重试。",
    formatGenerationError: (message) => `生成失败：${message}`,
    // 无 onGenerationFailure：失败停留 loading 阶段（phase 从未离开），展示错误 + 重试
    buildInputText: () => decodedCategory,
    saveErrorMessage: "练习结果保存失败",
    onSaveError: (message) => dispatch({ type: "SET_SAVE_ERROR", error: message }),
  });
  // 30 秒超时提示：加载超过 30 秒后显示"重新生成"建议
  const { showRetryHint } = useRetryHint(isGenerating);

  /** 挂载时调用 LLM 生成练习题 */
  useEffect(() => {
    if (!decodedCategory) return;

    abort();
    generateExercises();
    return () => abort();
  }, [decodedCategory, generateExercises, abort]);

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

    // 持久化练习结果，供 HistoryDetailPage 回顾时读取。
    // stringify / 侧信道 ref / null 检查都在 persistWithResult 内部；
    // 失败时它已回调 onSaveError（SET_SAVE_ERROR），页面无需再判空
    const result: ExerciseResult = {
      category: decodedCategory,
      exercises,
      userAnswers,
      score: computedScore,
    };
    await persistWithResult(result);
  }

  /**
   * 重新生成练习题。
   *
   * 调用时机：
   * - 回顾阶段点击"再来一轮"按钮
   * - 加载超时提示中点击"重新生成"
   * - 生成失败停留在 loading 阶段时点击"重新生成"
   *
   * 关键步骤：
   * 1. 显式清除错误槽：失败态下 phase 已是 "loading"，transition("loading")
   *    会因同阶段早退而不触发 onEnter 的 RESET —— 不手动清掉 error 的话，
   *    旧横幅会在重新生成期间持续显示，且成功后残留污染答题/回顾界面
   * 2. transition("loading") 重置其余状态（跨阶段进入时 onEnter 会分发 RESET）
   * 3. abort() 取消可能仍在进行的旧请求
   * 4. generateExercises 内的 streamChat 自行管理新的 AbortController
   */
  function handleRetry() {
    dispatch({ type: "CLEAR_ERRORS" });
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
          {/* 当前级别徽章：题目按该级别命制；修改入口在设置 → 英语水平定级 */}
          <Badge variant="outline" className="font-normal">
            {levelLabel(level)}
          </Badge>
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
          {/* 当前级别徽章：题目按该级别命制；修改入口在设置 → 英语水平定级 */}
          <Badge variant="outline" className="font-normal">
            {levelLabel(level)}
          </Badge>
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
                onAnswer={handleAnswer}
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
