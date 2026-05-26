import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { streamChat, buildPrompt } from "@/services/llm";
import { getDefaultModel, addHistory } from "@/lib/db";
import { ArrowLeft, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { matchAnswer } from "@/lib/parse-utils";
import { setTaskStatus, markTaskCompleted } from "@/lib/task-status";
import type { ExerciseQuestion, ExerciseResult, ExerciseType } from "@/types";

/** 练习流程的三个阶段：生成中 → 答题中 → 回顾 */
type Phase = "loading" | "answering" | "review";

/**
 * 各错误类别对应的题型映射。
 * 决定 LLM 生成哪种类型的练习题。
 */
const CATEGORY_EXERCISE_TYPE: Record<string, ExerciseType> = {
  "时态错误": "fill",
  "主谓一致": "fill",
  "单复数": "fill",
  "冠词错误": "correct",
  "介词错误": "correct",
  "用词不当": "rewrite",
  "句式杂糅": "rewrite",
  "拼写错误": "rewrite",
  "标点错误": "rewrite",
  "缺少成分": "rewrite",
  "语序错误": "rewrite",
};

/** 题型的中文说明，用于 prompt 和 UI 展示 */
const EXERCISE_TYPE_LABEL: Record<ExerciseType, string> = {
  fill: "填空题（选择正确的词形或选项）",
  correct: "改错题（找出并改正句中的错误）",
  rewrite: "重写题（用正确的方式重写句子）",
};

/**
 * 构建练习题生成的 prompt。
 * 根据错误类别和对应题型，要求 LLM 生成 5 道结构化 JSON 练习题。
 */
function buildExercisePrompt(category: string): string {
  const exerciseType = CATEGORY_EXERCISE_TYPE[category] ?? "rewrite";
  const typeLabel = EXERCISE_TYPE_LABEL[exerciseType];

  return `你是一个专业的英语语法教练。用户在"${category}"方面存在薄弱项，请生成 5 道针对性练习题帮助其巩固。

题型：${typeLabel}

请严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹：

{
  "exercises": [
    {
      "type": "${exerciseType}",
      "question": "题目描述（包含完整的句子或语境）",
      ${exerciseType === "fill" ? '"options": ["选项A", "选项B", "选项C", "选项D"],' : ""}
      "answer": "正确答案",
      "explanation": "中文解析，说明为什么这个答案正确"
    }
  ]
}

要求：
- 5 道题难度递进，从简单到中等
- 题目内容贴近实际英语使用场景
- explanation 用中文简洁明了地解释语法点
- ${exerciseType === "fill" ? "每题 4 个选项，只有 1 个正确" : ""}
- ${exerciseType === "correct" ? "每题包含 1 个错误，用户需要找出并改正" : ""}
- ${exerciseType === "rewrite" ? "给出有问题的句子，用户需要用正确方式重写" : ""}
- 只输出 JSON，不要其他内容`;
}

/**
 * 校验 LLM 返回的练习题结构是否完整。
 * 每道题必须包含 type、question、answer、explanation 四个字段。
 */
function isValidExercises(arr: unknown[]): arr is ExerciseQuestion[] {
  return arr.every(
    (e: any) => e && typeof e.type === "string" && typeof e.question === "string"
      && typeof e.answer === "string" && typeof e.explanation === "string"
  );
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

  // --- 核心流程状态 ---
  const [phase, setPhase] = useState<Phase>("loading");        // 当前阶段：loading → answering → review
  const [exercises, setExercises] = useState<ExerciseQuestion[]>([]);  // LLM 生成的练习题列表
  const [userAnswers, setUserAnswers] = useState<string[]>([]); // 用户答案，与 exercises 等长，下标一一对应
  const [error, setError] = useState<string | null>(null);      // 全局错误提示（模型未配置、生成失败等）

  // --- 辅助 UI 状态 ---
  const [showRetryHint, setShowRetryHint] = useState(false);    // 加载超过 30 秒后显示"重新生成"提示
  const [saveError, setSaveError] = useState<string | null>(null); // history 表写入失败时的警告信息
  const [score, setScore] = useState(0);                          // 本次得分（review 阶段由 handleSubmit 设置）

  // --- AbortController 引用 ---
  // 用于取消进行中的 LLM 请求。handleRetry 和 useEffect 都会创建新的 controller。
  const abortRef = useRef<AbortController | null>(null);

  // URL 参数解码：category 可能包含中文（如"时态错误"），需要 decodeURIComponent
  const decodedCategory = category ? decodeURIComponent(category) : "";

  /**
   * 解析 LLM 返回的原始文本为练习题数组。
   *
   * 两级回退策略（与 parseCorrectionJson 类似但更轻量）：
   * 1. 直接 JSON.parse（LLM 按要求输出纯 JSON）
   * 2. 从 ```json ``` 代码块中提取（LLM 有时会包裹代码块）
   *
   * 解析成功后还会校验 exercises 数组结构（isValidExercises），
   * 确保每道题包含 type/question/answer/explanation 四个必要字段。
   *
   * @throws 解析失败或结构校验不通过时抛出 Error，由调用方 catch 处理
   */
  function parseExercises(raw: string): ExerciseQuestion[] {
    let jsonStr = raw.trim();
    // 第一级回退：兼容 LLM 用 ```json ``` 包裹的情况
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

    const parsed = JSON.parse(jsonStr);

    // 校验顶层结构：必须有 exercises 数组
    if (!parsed.exercises || !Array.isArray(parsed.exercises)) {
      throw new Error("格式异常：缺少 exercises 数组");
    }
    // 校验每道题的字段完整性（type/question/answer/explanation 缺一不可）
    if (!isValidExercises(parsed.exercises)) {
      throw new Error("格式异常：练习题字段不完整");
    }
    return parsed.exercises;
  }

  /**
   * 调用 LLM 生成练习题的核心逻辑。
   *
   * 供两处调用：
   * - useEffect（页面首次挂载或 category 变化时）
   * - handleRetry（用户点击"再来一轮"或超时提示中的"重新生成"）
   *
   * 任务状态上报流程：
   *   setTaskStatus("exercise", true)  → 请求开始，Layout 顶部显示蓝色加载条
   *   markTaskCompleted("exercise")    → 解析成功，Layout 顶部显示绿色完成标记
   *   setTaskStatus("exercise", false) → 出错或模型未配置，回到 idle 状态
   *
   * @param signal - AbortSignal，用于取消进行中的请求（页面卸载或重试时）
   */
  const generateExercises = useCallback(async (signal: AbortSignal) => {
    // 前置检查：未配置模型时直接报错，不发请求
    const model = await getDefaultModel();
    if (!model?.api_key) {
      setError("请先在设置页面配置 LLM 模型。");
      setPhase("answering");
      setTaskStatus("exercise", false);
      return;
    }

    const prompt = buildExercisePrompt(decodedCategory);
    const messages = buildPrompt(prompt, "");

    // 通知 Layout 状态栏：任务开始
    setTaskStatus("exercise", true);

    let raw = "";
    await streamChat(
      messages,
      model,
      {
        // SSE 流式回调：逐 token 拼接完整响应
        onToken: (token) => { raw += token; },
        // 流式结束：解析 JSON 并更新状态
        onDone: () => {
          try {
            const list = parseExercises(raw);
            setExercises(list);
            setUserAnswers(new Array(list.length).fill("")); // 初始化空答案数组
            setPhase("answering");
            markTaskCompleted("exercise"); // 通知 Layout：任务完成
          } catch {
            setError("解析练习题失败，请重试。");
            setPhase("answering");
            setTaskStatus("exercise", false); // 解析失败，回到 idle
          }
        },
        // 网络/API 错误回调
        onError: (err) => {
          setError(`生成失败：${err.message}`);
          setPhase("answering");
          setTaskStatus("exercise", false); // 出错，回到 idle
        },
      },
      signal
    );
  }, [decodedCategory]); // decodedCategory 变化时重新创建函数（触发 useEffect 重新生成）

  /** 挂载时调用 LLM 生成练习题 */
  useEffect(() => {
    if (!decodedCategory) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    generateExercises(controller.signal);
    return () => controller.abort();
  }, [decodedCategory, generateExercises]);

  /**
   * 30 秒超时提示。
   *
   * 当 LLM API 响应缓慢或不可用时，用户可能长时间看到加载动画而无任何反馈。
   * 此 useEffect 在进入 loading 阶段时启动 30 秒定时器：
   * - 超时后显示"生成时间较长，请耐心等待或重新生成"的琥珀色提示
   * - 离开 loading 阶段时自动清除定时器并重置提示状态
   * - 重新进入 loading 阶段（handleRetry）时重新开始计时
   *
   * 注意：不中断正在进行的 LLM 请求，提示是纯建议性的。
   */
  useEffect(() => {
    if (phase !== "loading") {
      setShowRetryHint(false); // 离开 loading 阶段时重置提示
      return;
    }
    const timer = setTimeout(() => setShowRetryHint(true), 30_000);
    return () => clearTimeout(timer); // 清理：避免内存泄漏和过期回调
  }, [phase]);

  /** 更新某题的用户答案 */
  function setAnswer(index: number, value: string) {
    setUserAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
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
    setPhase("review");

    // 逐题判分：matchAnswer 根据题型采用不同的比对策略
    const computedScore = exercises.reduce(
      (sum, ex, i) => sum + (matchAnswer(userAnswers[i] ?? "", ex.answer, ex.type) ? 1 : 0),
      0
    );
    setScore(computedScore); // 存入 state，供 UI 显示和 handleRetry 重置

    // 持久化练习结果，供 HistoryDetailPage 回顾时读取
    const result: ExerciseResult = {
      category: decodedCategory,
      exercises,
      userAnswers,
      score: computedScore,
    };
    await addHistory({
      type: "exercise",
      input_text: decodedCategory,
      result: JSON.stringify(result),
    }).catch(() => {
      // DB 写入失败不阻塞回顾，仅显示警告横幅
      setSaveError("练习结果保存失败，但你仍可查看本次作答。");
    });
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
    setPhase("loading");
    setExercises([]);
    setUserAnswers([]);
    setError(null);
    setSaveError(null);
    setScore(0);
    abortRef.current?.abort(); // 取消旧请求
    const controller = new AbortController();
    abortRef.current = controller; // 存储新 controller
    generateExercises(controller.signal);
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
  if (phase === "loading") {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
          <h2 className="text-xl font-bold">弱项训练：{decodedCategory}</h2>
        </div>
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm">正在生成针对性练习题...</p>
          {/* 超时提示：30 秒后显示，由 showRetryHint useEffect 控制 */}
          {showRetryHint && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              生成时间较长，请耐心等待或
              <button
                className="underline font-medium ml-1 hover:text-amber-700 dark:hover:text-amber-300"
                onClick={handleRetry}
              >
                重新生成
              </button>
            </p>
          )}
        </div>
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
        {phase === "review" && (
          <span className="text-sm font-medium text-muted-foreground">
            得分：{score}/{exercises.length}
          </span>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* 保存失败警告 */}
      {saveError && phase === "review" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-600 dark:text-amber-400">
          {saveError}
        </div>
      )}

      {/* 题目列表 */}
      {exercises.length > 0 && (
        <div className="space-y-6">
          {exercises.map((ex, i) => (
            <ExerciseCard
              key={i}
              index={i}
              exercise={ex}
              userAnswer={userAnswers[i] ?? ""}
              onAnswerChange={(v) => setAnswer(i, v)}
              showReview={phase === "review"}
            />
          ))}
        </div>
      )}

      {/* 底部操作栏 */}
      {exercises.length > 0 && phase === "answering" && (
        <div className="flex justify-center pt-4">
          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={userAnswers.every((a) => !a.trim())}
          >
            提交答案
          </Button>
        </div>
      )}

      {/* 回顾阶段的操作栏 */}
      {phase === "review" && (
        <div className="flex justify-center gap-3 pt-4">
          <Button variant="outline" onClick={handleRetry}>
            再来一轮
          </Button>
          <Button onClick={() => navigate("/analytics")}>
            返回学习分析
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * 单题卡片组件 —— ExercisePage 的核心 UI 单元。
 *
 * 根据题目类型渲染不同的输入方式：
 * - fill（填空题）: 4 选 1 按钮组，点击选择答案
 * - correct（改错题）/ rewrite（重写题）: 文本输入框，自由输入
 *
 * 回顾模式（showReview=true）下的额外行为：
 * - 卡片边框变色：正确=绿色，错误=红色
 * - fill 类型：正确选项标绿，错误选中标红
 * - correct/rewrite 类型：显示用户答案 + 正确答案（若答错）
 * - 底部显示对错标记 + LLM 生成的解析
 *
 * @param index - 题目序号（0-based，UI 显示 +1）
 * @param exercise - 练习题数据（来自 LLM 生成）
 * @param userAnswer - 当前用户的答案文本
 * @param onAnswerChange - 答案变更回调（父组件更新 userAnswers 数组）
 * @param showReview - 是否处于回顾模式
 */
function ExerciseCard({
  index,
  exercise,
  userAnswer,
  onAnswerChange,
  showReview,
}: {
  index: number;
  exercise: ExerciseQuestion;
  userAnswer: string;
  onAnswerChange: (value: string) => void;
  showReview: boolean;
}) {
  // 回顾模式下使用 matchAnswer 按题型比对（fill 精确匹配，correct/rewrite 归一化匹配）
  const isCorrect = showReview && matchAnswer(userAnswer, exercise.answer, exercise.type);

  return (
    // 回顾模式下卡片边框颜色反映对错：绿色=正确，红色=错误
    <div className={`rounded-lg border p-5 space-y-4 ${showReview ? (isCorrect ? "border-green-500/40 bg-green-500/5" : "border-red-500/40 bg-red-500/5") : ""}`}>
      {/* 题号 + 题目 */}
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
          {index + 1}
        </span>
        <p className="text-sm leading-relaxed">{exercise.question}</p>
      </div>

      {/* 填空题：2×2 网格选项按钮组 */}
      {exercise.type === "fill" && exercise.options && (
        <div className="grid grid-cols-2 gap-2 ml-9">
          {exercise.options.map((opt, oi) => {
            const selected = userAnswer === opt;        // 用户是否选了此项
            const isAnswer = showReview && opt === exercise.answer; // 此项是否为正确答案
            return (
              <button
                key={oi}
                disabled={showReview} // 回顾模式下禁用点击
                onClick={() => onAnswerChange(opt)}
                className={`text-sm px-3 py-2 rounded-md border text-left transition-colors ${
                  // 四种样式状态：
                  // 1. 回顾 + 正确答案 → 绿色高亮
                  // 2. 回顾 + 用户选了但不是答案 → 红色标记
                  // 3. 回顾 + 未选且非答案 → 灰色淡化
                  // 4. 答题中 + 已选 → 主题色高亮；未选 → 默认边框 + hover 效果
                  showReview
                    ? isAnswer
                      ? "border-green-500 bg-green-500/10 text-green-700 dark:text-green-300"
                      : selected
                        ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
                        : "border-border/40 text-muted-foreground"
                    : selected
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      )}

      {/* 改错/重写题：文本输入 */}
      {(exercise.type === "correct" || exercise.type === "rewrite") && (
        <div className="ml-9">
          <Input
            value={userAnswer}
            onChange={(e) => onAnswerChange(e.target.value)}
            placeholder={exercise.type === "correct" ? "输入改正后的句子..." : "输入重写的句子..."}
            disabled={showReview}
            className="text-sm"
          />
        </div>
      )}

      {/* 回顾模式：显示结果 */}
      {showReview && (
        <div className="ml-9 space-y-2 pt-2 border-t border-border/40">
          <div className="flex items-center gap-2">
            {isCorrect ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            )}
            <span className={`text-sm font-medium ${isCorrect ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {isCorrect ? "回答正确" : "回答错误"}
            </span>
          </div>
          {!isCorrect && (
            <p className="text-sm">
              <span className="text-muted-foreground">正确答案：</span>
              <span className="font-medium text-green-600 dark:text-green-400">{exercise.answer}</span>
            </p>
          )}
          <p className="text-sm text-muted-foreground">{exercise.explanation}</p>
        </div>
      )}
    </div>
  );
}
