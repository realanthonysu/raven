/**
 * usePlacementTest —— AI 定级测试（Track A）的完整生命周期 hook。
 *
 * 状态机 intro → testing → result 由消费方（PlacementTestDialog）用
 * usePhaseMachine 驱动；本 hook 只负责数据与副作用：
 * - generate()：取默认模型 → streamChatAsync 一次性命题 → 信封解析 →
 *   无效题过滤；失败时给出可重试的错误文案，abort 静默收尾。
 * - setAnswer()/submit()：收集答案（null = 未答，计分时按错误处理），
 *   scorePlacement 本地规则计分，构造 PlacementResult 持久化到 settings
 *   的 placement_result 键。提交在途期间重复调用直接返回 null（连点只
 *   落库一次）；reset() 递增提交序号使迟到结果作废。
 * - retrySave()：submit 持久化失败后重试保存（saveError 清除）。
 * - applyResult()：把估计级别经 setLevelGlobal 写全局级别 store
 *   （write-through 持久化，对话框收尾直接用）。
 * - reset()：对话框关闭/重新开始时调用，abort 在途命题请求并清空状态。
 *
 * 与 useGraphData 同款并发防护：useAbortable（放弃本地等待）+
 * useStaleGuard（迟到结果不得写坏新一轮 state）；submit 另用独立序号
 * ref，避免与 generate 的守卫相互失效。
 */

import { useCallback, useRef, useState } from "react";
import { z } from "zod";
import { useAbortable } from "@/hooks/use-abortable";
import { setLevelGlobal } from "@/hooks/use-proficiency-level";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "@/hooks/use-stream-chat";
import { getDefaultModelCached } from "@/lib/db";
import { setPlacementResult } from "@/lib/db/settings";
import { getErrorMessage } from "@/lib/error-utils";
import {
  isUsablePlacementQuestion,
  type PlacementScore,
  scorePlacement,
} from "@/lib/level-estimation";
import { extractJsonSafe } from "@/lib/parse-utils";
import type { PlacementQuestion, PlacementResult } from "@/lib/schemas";
import { PlacementQuestionSchema } from "@/lib/schemas";
import { PLACEMENT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";

/**
 * LLM 响应信封：宽松 { questions: unknown[] }。
 * 刻意不用 makeListEnvelope + PlacementQuestionSchema 的严格信封——那会让
 * 任一道结构非法的题导致整批解析失败（all-or-nothing）；这里先收齐数组，
 * 由 generate() 逐题 safeParse 剔除坏题。
 */
const PLACEMENT_QUESTIONS_ENVELOPE = z.object({ questions: z.array(z.unknown()) });

/** 命题超时：12 题一次性生成，高于流式默认 120s（与知识图谱第二步同规格） */
const GENERATE_TIMEOUT_MS = 180_000;

/** buildPrompt 的 user 消息内容（system 提示已含全部命题要求，此处仅作触发） */
const GENERATE_USER_CONTENT = "请生成 12 道定级测试单选题。";

/** 解析失败/无有效题时的可重试错误文案 */
const GENERATE_RETRY_MESSAGE = "未能生成有效的测试题，请重试。";

/** 由计分结果构造待持久化的 PlacementResult（submit 与 retrySave 共用） */
function buildPlacementResult(score: PlacementScore): PlacementResult {
  return {
    tested_at: new Date().toISOString(),
    estimated_level: score.estimated,
    // per_band 存各档正确率（PlacementResultSchema 契约：0-1 小数）
    per_band: Object.fromEntries(
      score.perBand.map((b): [string, number] => [b.band, b.total > 0 ? b.correct / b.total : 0]),
    ),
    question_count: score.totalCount,
    total_correct: score.totalCorrect,
  };
}

export interface UsePlacementTestResult {
  /** 当前测试题（已过滤无效题） */
  questions: PlacementQuestion[];
  /** 用户答案，与 questions 等长（null = 未作答） */
  answers: (string | null)[];
  /** 最近一次计分结果（submit 后非空，结果页消费） */
  score: PlacementScore | null;
  /** 是否正在生成题目 */
  generating: boolean;
  /** 是否正在提交计分（结果持久化在途） */
  submitting: boolean;
  /** 最近一次错误信息（含模型未配置的规范文案） */
  error: string | null;
  /** 结果持久化失败信息（非 null 时结果页展示重试入口） */
  saveError: string | null;
  /** 生成题目；返回是否有有效题可进入答题阶段 */
  generate: () => Promise<boolean>;
  /** 记录某题的用户选择 */
  setAnswer: (index: number, option: string) => void;
  /** 计分并持久化；返回计分结果（无题/在途中被复位时返回 null） */
  submit: () => Promise<PlacementScore | null>;
  /** 持久化失败后重试保存（成功清除 saveError） */
  retrySave: () => Promise<void>;
  /** 把估计级别应用为当前级别（全局 store write-through） */
  applyResult: () => void;
  /** 复位：abort 在途请求并清空全部状态 */
  reset: () => void;
}

export function usePlacementTest(): UsePlacementTestResult {
  const [questions, setQuestions] = useState<PlacementQuestion[]>([]);
  const [answers, setAnswers] = useState<(string | null)[]>([]);
  const [score, setScore] = useState<PlacementScore | null>(null);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();
  const { begin, isStale } = useStaleGuard();
  /** submit 在途标记：连点只允许一次落库 */
  const submitInFlightRef = useRef(false);
  /** submit 序号：reset 递增使在途提交的迟到结果作废（与 generate 的守卫独立） */
  const submitSeqRef = useRef(0);

  /**
   * 生成测试题：模型预检 → LLM 命题 → 信封解析 → 无效题过滤。
   * 任何一步失败都落到 error（可重试）；被中止/被取代时静默返回 false。
   */
  const generate = useCallback(async (): Promise<boolean> => {
    // 重新生成 = abort 旧请求再发起新请求
    abort();
    const signal = getSignal();
    const seq = begin();

    setGenerating(true);
    setError(null);
    setQuestions([]);
    setAnswers([]);
    setScore(null);

    const model = await getDefaultModelCached();
    if (isStale(seq)) return false;
    if (!model?.api_key) {
      // 未配置模型：规范文案（MODEL_NOT_CONFIGURED_MESSAGE，全站唯一来源）
      setError(MODEL_NOT_CONFIGURED_MESSAGE);
      setGenerating(false);
      return false;
    }

    try {
      const text = await streamChatAsync(
        buildPrompt(PLACEMENT_PROMPT, GENERATE_USER_CONTENT),
        model,
        signal,
        GENERATE_TIMEOUT_MS,
      );
      // 中止/被取代：迟到结果既不解析也不写 state
      if (signal.aborted || isStale(seq)) return false;

      const parsed = extractJsonSafe(text, PLACEMENT_QUESTIONS_ENVELOPE);
      // 逐题结构校验：单题非法只剔除该题，其余题照常可用（信封宽松，
      // 不再 all-or-nothing）；通过结构校验的题再经 isUsablePlacementQuestion
      // 校验 band/选项数/答案一致性，非法题不计入分母
      const usable: PlacementQuestion[] = [];
      for (const item of parsed?.questions ?? []) {
        const r = PlacementQuestionSchema.safeParse(item);
        if (r.success && isUsablePlacementQuestion(r.data)) usable.push(r.data);
      }
      if (isStale(seq)) return false;
      if (usable.length === 0) {
        setError(GENERATE_RETRY_MESSAGE);
        return false;
      }
      setQuestions(usable);
      setAnswers(usable.map(() => null));
      return true;
    } catch (err) {
      // 中止不是失败：静默收尾；其余错误透出真实原因供重试判断
      if (signal.aborted || isStale(seq)) return false;
      setError(`试题生成失败：${getErrorMessage(err)}`);
      return false;
    } finally {
      // 过期调用不拥有 loading：若已有新 generate 接管，loading 归它所有
      if (!isStale(seq)) setGenerating(false);
    }
  }, [abort, getSignal, begin, isStale]);

  /** 记录某题的用户选择（未答的题保持 null，提交时按错误处理） */
  const setAnswer = useCallback((index: number, option: string) => {
    setAnswers((prev) => prev.map((a, i) => (i === index ? option : a)));
  }, []);

  /**
   * 计分 → 构造 PlacementResult → 持久化。
   * 在途期间重复调用直接返回 null（连点只落库一次）；reset 使迟到结果
   * 作废（返回 null 且不写 state）。持久化失败设置 saveError，结果仍
   * 展示（retrySave 可重试）。
   */
  const submit = useCallback(async (): Promise<PlacementScore | null> => {
    if (questions.length === 0) return null;
    if (submitInFlightRef.current) return null;
    submitInFlightRef.current = true;
    setSubmitting(true);
    const seq = ++submitSeqRef.current;

    const nextScore = scorePlacement(questions, answers);
    try {
      await setPlacementResult(buildPlacementResult(nextScore));
      if (submitSeqRef.current === seq) setSaveError(null);
    } catch (e) {
      // 持久化失败降级为"仅本次会话可见"：结果页仍可展示，saveError 提示重试
      if (submitSeqRef.current === seq) setSaveError(`保存失败：${getErrorMessage(e)}`);
    }

    // 在途期间被 reset：迟到结果不写 state、不返回
    if (submitSeqRef.current !== seq) return null;
    submitInFlightRef.current = false;
    setSubmitting(false);
    setScore(nextScore);
    return nextScore;
  }, [questions, answers]);

  /** 持久化失败重试：用已持有的 score 重建结果再存一次（成功清除 saveError） */
  const retrySave = useCallback(async () => {
    if (!score) return;
    try {
      await setPlacementResult(buildPlacementResult(score));
      setSaveError(null);
    } catch (e) {
      setSaveError(`保存失败：${getErrorMessage(e)}`);
    }
  }, [score]);

  /** 应用估计级别为当前级别（无计分结果时不做任何事） */
  const applyResult = useCallback(() => {
    if (!score) return;
    setLevelGlobal(score.estimated);
  }, [score]);

  /** 复位：abort 在途命题请求、作废在途提交并清空全部状态（对话框关闭/重新开始） */
  const reset = useCallback(() => {
    abort();
    submitSeqRef.current += 1;
    submitInFlightRef.current = false;
    setQuestions([]);
    setAnswers([]);
    setScore(null);
    setError(null);
    setGenerating(false);
    setSubmitting(false);
    setSaveError(null);
  }, [abort]);

  return {
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
  };
}
