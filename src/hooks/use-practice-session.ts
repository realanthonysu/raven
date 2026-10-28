/**
 * usePracticeSession —— 练习页（弱项训练/听力/口语）的会话编排 module。
 *
 * ExercisePage / ListeningPage / SpeakingPage 此前各自围绕
 * `useLLMStreamPage({ autoPersist: false })` 抄写同一段 ~120-180 行骨架：
 * - onDone 里 extractJsonSafe 解析 → 成功分发 reducer / 失败 SET_ERROR；
 * - onError 里 SET_ERROR；
 * - 提交时「JSON.stringify 结果 → 写入 *ResultRef → persistResult() → null 则 SET_SAVE_ERROR」
 *   三分件套，*ResultRef 侧信道（exerciseResultRef / listeningResultRef /
 *   speakingResultRef）仅因 buildHistoryRecord 的签名带不动打分后的结果而存在；
 * - usePracticeGeneration 的 isGenerating 状态包装。
 *
 * 本 module 把这套编接收拢为「深模块」：页面只声明 prompt、schema、reducer 映射
 * 与错误文案，骨架与本 module 的两个私有 ref（resultRef / inputTextRef）——
 * 「ref 走私」从页面知识降为实现细节——都留在这里。
 *
 * 页面保留真正不同的流程职责：reducer 与 phase machine、retry 流向、
 * 口语的逐句媒体管线（use-speaking-session）、听力/口语的级别定格 ref。
 *
 * 行为契约（与三页原实现逐字段等价）：
 * - 解析失败文案与生成失败文案经参数注入，逐字保留各页原文案；
 * - persistWithResult 落库的 history 记录（type / input_text / result /
 *   difficulty_level）与改造前一致——这是 HistoryDetailPage 与 analytics
 *   的消费契约；difficulty_level 仍由 useLLMStreamPage 从 getDifficultyLevel
 *   合并补入，本 module 不改其语义。
 */
import { useCallback, useRef, useState } from "react";
import type { ZodType } from "zod";
import { useLatestRef } from "@/hooks/use-latest-ref";
import { type UseLLMStreamPageOptions, useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import type { LevelCode } from "@/lib/levels";
import { extractJsonSafe } from "@/lib/parse-utils";

/** 三个练习页的任务类型（TaskKey 的练习子集，见 lib/task-status 的槽位注册表） */
type PracticeActivityType = "exercise" | "listening" | "speaking";

export interface PracticeSessionConfig<TParsed> {
  /** useLLMStreamPage 的 activityType（task-status 槽位 + history type） */
  activityType: PracticeActivityType;
  /** 生成阶段 JSON 校验 schema（makeListEnvelope 产物，zod schema） */
  schema: ZodType<TParsed>;
  /** 透传 useLLMStreamPage.buildMessages（同步/异步均可） */
  buildMessages: UseLLMStreamPageOptions["buildMessages"];
  /** 透传 useLLMStreamPage.getDifficultyLevel（页面保持自己的定格 ref，本 hook 不改其语义） */
  getDifficultyLevel?: () => LevelCode | null;
  /** 解析成功回调：页面分发 reducer 动作并自行 transition 到答题阶段 */
  onParsed: (data: TParsed) => void;
  /** 失败上报出口：解析失败与生成失败都经此回到页面 reducer（页面传 dispatch SET_ERROR 的一行包装） */
  reportError: (message: string) => void;
  /** 解析失败文案，默认 "生成失败，请重试。"（Exercise 的 "解析练习题失败，请重试。" 经此保留） */
  parseErrorMessage?: string;
  /** 生成阶段 LLM 错误的文案包装，默认原样透传 err.message（Exercise 的 `生成失败：${msg}` 经此保留） */
  formatGenerationError?: (message: string) => string;
  /** 解析失败/生成失败上报后的额外回退动作（Listening 回 idle、Speaking 回 loading；Exercise 无——失败停留 loading） */
  onGenerationFailure?: () => void;
  /** 持久化时 history 记录的 input_text 构建器（在 persistWithResult 调用时求值，与原 buildHistoryRecord 同时序） */
  buildInputText: () => string;
  /** 持久化失败文案，默认 "保存失败"（Exercise 的 "练习结果保存失败" 经此保留） */
  saveErrorMessage?: string;
  /** 持久化失败回调：页面传 dispatch SET_SAVE_ERROR 的一行包装，参数为 saveErrorMessage 文案 */
  onSaveError: (message: string) => void;
}

export interface PracticeSession {
  /** 生成中标志（从发起 generate 到其 resolve 之间为 true，与原 usePracticeGeneration 语义一致） */
  isGenerating: boolean;
  /** 发起生成（内部调 useLLMStreamPage.handleSubmit("")，带 isGenerating 状态包装） */
  generate: () => Promise<void>;
  /** 中止（透传 useLLMStreamPage.abort） */
  abort: () => void;
  /**
   * 用打分后的结果对象持久化：内部 JSON.stringify(result)、求值 buildInputText()、
   * 调 persistResult()。返回 historyId（失败 null；失败时已回调 onSaveError）。
   * 这是 *ResultRef 侧信道的替代——页面不再持有 stringify / ref 写入 / null 检查三分件套。
   */
  persistWithResult: (result: unknown) => Promise<number | null>;
}

/**
 * 练习页会话编排 hook。
 *
 * onDone 的解析不走 try/catch：extractJsonSafe 失败返回 null 而非抛错
 * （原页面用 `throw new Error("parse failed")` 把 null 扭成 catch 分支，
 * 这里等价改写为 if/else）。
 */
export function usePracticeSession<TParsed>(
  config: PracticeSessionConfig<TParsed>,
): PracticeSession {
  // options 经 useLatestRef 读取最新值（与 useLLMStreamPage 同一 R6 模式）：
  // 页面的 onParsed/reportError 等回调无需 memoize，generate/persistWithResult
  // 的标识保持稳定（ExercisePage 的挂载 effect 依赖它们的稳定性）
  const configRef = useLatestRef(config);

  // 私有侧信道：persistWithResult 写入，buildHistoryRecord 在 persistStream
  // 时读取。stringify 与 ref 写入时机与原页面提交处逐行对应。
  const resultRef = useRef("");
  const inputTextRef = useRef("");

  const { activityType } = config;

  const { handleSubmit, abort, persistResult } = useLLMStreamPage({
    activityType,
    // 手动持久化模式：练习结果要等用户作答/打分后经 persistWithResult 落库
    autoPersist: false,
    buildMessages: config.buildMessages,
    getDifficultyLevel: config.getDifficultyLevel,
    onDone: (fullText) => {
      const current = configRef.current;
      const parsed = extractJsonSafe(fullText, current.schema);
      if (parsed) {
        current.onParsed(parsed);
      } else {
        current.reportError(current.parseErrorMessage ?? "生成失败，请重试。");
        current.onGenerationFailure?.();
      }
    },
    onError: (err) => {
      const current = configRef.current;
      current.reportError(current.formatGenerationError?.(err.message) ?? err.message);
      current.onGenerationFailure?.();
    },
    buildHistoryRecord: () => ({
      type: activityType,
      input_text: inputTextRef.current,
      result: resultRef.current,
    }),
  });

  // 吸收自 usePracticeGeneration：isGenerating 覆盖 handleSubmit 的整个 await
  // 窗口（含 buildMessages 的异步段），供 useRetryHint 的 30 秒计时与按钮禁用使用
  const [isGenerating, setIsGenerating] = useState(false);

  const generate = useCallback(async () => {
    setIsGenerating(true);
    try {
      await handleSubmit("");
    } finally {
      setIsGenerating(false);
    }
  }, [handleSubmit]);

  // configRef 通过 useLatestRef 同步，故意不放入依赖数组（与 useLLMStreamPage
  // 的 persistStream 同一处理），persistWithResult 标识保持稳定
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const persistWithResult = useCallback(
    async (result: unknown): Promise<number | null> => {
      const current = configRef.current;
      // 先写两个私有 ref 再持久化：buildHistoryRecord 在 persistStream 内同步读取
      inputTextRef.current = current.buildInputText();
      resultRef.current = JSON.stringify(result);
      const historyId = await persistResult();
      // null = 写库失败（persistStream 已本地消化，不再抛出）：交页面显示非阻断警告
      if (historyId === null) {
        current.onSaveError(current.saveErrorMessage ?? "保存失败");
      }
      return historyId;
    },
    [persistResult],
  );

  return { isGenerating, generate, abort, persistWithResult };
}
