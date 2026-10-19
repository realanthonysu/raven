/**
 * usePlacementTest —— AI 定级测试（Track A）的完整生命周期 hook。
 *
 * 状态机 intro → testing → result 由消费方（PlacementTestDialog）用
 * usePhaseMachine 驱动；本 hook 只负责数据与副作用：
 * - generate()：取默认模型 → streamChatAsync 一次性命题 → 信封解析 →
 *   无效题过滤；失败时给出可重试的错误文案，abort 静默收尾。
 * - setAnswer()/submit()：收集答案（null = 未答，计分时按错误处理），
 *   scorePlacement 本地规则计分，构造 PlacementResult 持久化到 settings
 *   的 placement_result 键。
 * - applyResult()：把估计级别经 setLevelGlobal 写全局级别 store
 *   （write-through 持久化，对话框收尾直接用）。
 * - reset()：对话框关闭/重新开始时调用，abort 在途命题请求并清空状态。
 *
 * 与 useGraphData 同款并发防护：useAbortable（放弃本地等待）+
 * useStaleGuard（迟到结果不得写坏新一轮 state）。
 */

import { useCallback, useState } from "react";
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
import { makeListEnvelope, PlacementQuestionSchema } from "@/lib/schemas";
import { PLACEMENT_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";

/** LLM 响应信封：{ "questions": [...] }；nonempty —— 空列表按"输出不可用"走重试路径 */
const PLACEMENT_QUESTIONS_ENVELOPE = makeListEnvelope("questions", PlacementQuestionSchema, {
  nonempty: true,
});

/** 命题超时：12 题一次性生成，高于流式默认 120s（与知识图谱第二步同规格） */
const GENERATE_TIMEOUT_MS = 180_000;

/** buildPrompt 的 user 消息内容（system 提示已含全部命题要求，此处仅作触发） */
const GENERATE_USER_CONTENT = "请生成 12 道定级测试单选题。";

/** 解析失败/无有效题时的可重试错误文案 */
const GENERATE_RETRY_MESSAGE = "未能生成有效的测试题，请重试。";

export interface UsePlacementTestResult {
  /** 当前测试题（已过滤无效题） */
  questions: PlacementQuestion[];
  /** 用户答案，与 questions 等长（null = 未作答） */
  answers: (string | null)[];
  /** 最近一次计分结果（submit 后非空，结果页消费） */
  score: PlacementScore | null;
  /** 是否正在生成题目 */
  generating: boolean;
  /** 最近一次错误信息（含模型未配置的规范文案） */
  error: string | null;
  /** 生成题目；返回是否有有效题可进入答题阶段 */
  generate: () => Promise<boolean>;
  /** 记录某题的用户选择 */
  setAnswer: (index: number, option: string) => void;
  /** 计分并持久化；返回计分结果（无题时返回 null） */
  submit: () => Promise<PlacementScore | null>;
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
  const [error, setError] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();
  const { begin, isStale } = useStaleGuard();

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
      // schema 宽松（band 为 string、options 不定长），有效性以计分前的
      // isUsablePlacementQuestion 为准：非法题直接剔除，不计入分母
      const usable = parsed ? parsed.questions.filter(isUsablePlacementQuestion) : [];
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

  /** 计分 → 构造 PlacementResult → 持久化（失败仅 warn，不阻塞结果展示） */
  const submit = useCallback(async (): Promise<PlacementScore | null> => {
    if (questions.length === 0) return null;
    const nextScore = scorePlacement(questions, answers);
    setScore(nextScore);
    const result: PlacementResult = {
      tested_at: new Date().toISOString(),
      estimated_level: nextScore.estimated,
      // per_band 存各档正确率（PlacementResultSchema 契约：0-1 小数）
      per_band: Object.fromEntries(
        nextScore.perBand.map((b): [string, number] => [
          b.band,
          b.total > 0 ? b.correct / b.total : 0,
        ]),
      ),
      question_count: nextScore.totalCount,
      total_correct: nextScore.totalCorrect,
    };
    try {
      await setPlacementResult(result);
    } catch (e) {
      // 持久化失败降级为"仅本次会话可见"：结果页仍可展示，重启后丢失
      console.warn("[placement] 保存定级测试结果失败:", e);
    }
    return nextScore;
  }, [questions, answers]);

  /** 应用估计级别为当前级别（无计分结果时不做任何事） */
  const applyResult = useCallback(() => {
    if (!score) return;
    setLevelGlobal(score.estimated);
  }, [score]);

  /** 复位：abort 在途命题请求并清空全部状态（对话框关闭/重新开始） */
  const reset = useCallback(() => {
    abort();
    setQuestions([]);
    setAnswers([]);
    setScore(null);
    setError(null);
    setGenerating(false);
  }, [abort]);

  return {
    questions,
    answers,
    score,
    generating,
    error,
    generate,
    setAnswer,
    submit,
    applyResult,
    reset,
  };
}
