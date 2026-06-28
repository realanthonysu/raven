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
import { useCallback, useEffect, useReducer } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { ExerciseCard } from "@/components/ExerciseCard";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { ErrorBanner, LoadingIndicator, WarningBanner } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { buildPersonalizedContext, savePracticeResult } from "@/lib/db";
import { extractJson, matchAnswer } from "@/lib/parse-utils";
import { ExerciseQuestionSchema } from "@/lib/schemas";
import { buildExercisePrompt } from "@/prompts";
import type { ExerciseQuestion, ExerciseResult } from "@/types";

/** 练习流程的三个阶段：生成中 → 答题中 → 回顾 */
type Phase = "loading" | "answering" | "review";

/**
 * Zod schema for validating LLM-generated exercise response.
 * 仅校验生成阶段的 { exercises: [...] } 结构，与 ExerciseResultSchema（完整结果）区分。
 */
const ExerciseGenerationSchema = z.object({
  exercises: z.array(ExerciseQuestionSchema),
});

// ======================================================================
// useReducer 集中管理弱项训练页面的关联状态（参照 SpeakingPage 的 reducer 模式）
// 将 exercises / userAnswers / score / error / saveError
// 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
// ======================================================================

/** ExercisePage 组件内的关联状态 */
interface ExerciseState {
  exercises: ExerciseQuestion[]; // LLM 生成的练习题列表
  userAnswers: string[]; // 用户答案，与 exercises 等长，下标一一对应
  score: number; // 本次得分（review 阶段由 handleSubmit 设置）
  error: string | null; // 全局错误提示（模型未配置、生成失败等）
  saveError: string | null; // history 表写入失败时的警告信息
}

/** ExercisePage reducer 的 action 类型 */
type ExerciseAction =
  | { type: "SET_EXERCISES"; exercises: ExerciseQuestion[]; answers: string[] }
  | { type: "SET_ANSWER"; index: number; value: string }
  | { type: "SET_SCORE"; score: number }
  | { type: "SET_ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SET_SAVE_ERROR"; message: string }
  | { type: "RESET" };

/** Exercise reducer 初始状态 */
const initialExerciseState: ExerciseState = {
  exercises: [],
  userAnswers: [],
  score: 0,
  error: null,
  saveError: null,
};

/**
 * Exercise reducer — 集中处理所有关联状态变更。
 * 参照 SpeakingPage 的 speakingReducer 模式。
 */
function exerciseReducer(state: ExerciseState, action: ExerciseAction): ExerciseState {
  switch (action.type) {
    case "SET_EXERCISES":
      return {
        ...state,
        exercises: action.exercises,
        userAnswers: action.answers,
      };
    case "SET_ANSWER": {
      const next = [...state.userAnswers];
      next[action.index] = action.value;
      return { ...state, userAnswers: next };
    }
    case "SET_SCORE":
      return { ...state, score: action.score };
    case "SET_ERROR":
      return { ...state, error: action.message };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SAVE_ERROR":
      return { ...state, saveError: action.message };
    case "RESET":
      return initialExerciseState;
    default:
      return state;
  }
}

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

  // 30 秒超时提示：加载超过 30 秒后显示"重新生成"建议
  const { showRetryHint } = useRetryHint(isPhase("loading"));

  // --- LLM 流式调用 hook ---
  const { execute, abort } = useStreamChat("exercise");

  // URL 参数解码：category 可能包含中文（如"时态错误"），需要 decodeURIComponent
  const decodedCategory = category ? decodeURIComponent(category) : "";

  /**
   * 调用 LLM 生成练习题的核心逻辑。
   *
   * 供两处调用：
   * - useEffect（页面首次挂载或 category 变化时）
   * - handleRetry（用户点击"再来一轮"或超时提示中的"重新生成"）
   */
  const generateExercises = useCallback(async () => {
    const context = await buildPersonalizedContext(10);
    const prompt = buildExercisePrompt(decodedCategory, context || undefined);

    await execute(prompt, "", {
      onToken: () => {},
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
          dispatch({ type: "SET_ERROR", message: "解析练习题失败，请重试。" });
        }
      },
      onError: (err) => {
        dispatch({ type: "SET_ERROR", message: `生成失败：${err.message}` });
      },
    });
  }, [decodedCategory, execute, transition]);

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
  async function handleSubmit() {
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
    const { historySaved } = await savePracticeResult(
      "exercise",
      decodedCategory,
      JSON.stringify(result),
    );
    if (!historySaved) {
      dispatch({ type: "SET_SAVE_ERROR", message: "练习结果保存失败，但你仍可查看本次作答。" });
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
  if (isPhase("loading")) {
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
            {showRetryHint && (
              <Button
                variant="link"
                size="sm"
                className="text-amber-600 dark:text-amber-400"
                onClick={handleRetry}
              >
                生成时间较长？重新生成
              </Button>
            )}
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
                key={ex.question.slice(0, 50)}
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
          <Button size="lg" onClick={handleSubmit} disabled={userAnswers.every((a) => !a.trim())}>
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
