/**
 * useGraphData —— 封装知识图谱的 LLM 生成和状态管理。
 *
 * 两步生成策略：
 * 1. 将长文章压缩为保留关键概念的简短摘要（避免 token 超限）
 * 2. 从摘要生成知识图谱 JSON（输入更短，响应更快，质量更好）
 *
 * ReadingPage 在六维分析完成后异步调用此 hook 生成概念关系图谱，
 * 不阻塞主流程。成功后同时更新 React state 和 SQLite history 表。
 */
import { useCallback, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { getDefaultModelCached, updateHistoryGraphData } from "@/lib/db";
import { extractJsonSafe } from "@/lib/parse-utils";
import { GraphDataSchema } from "@/lib/schemas";
import { GRAPH_DATA_PROMPT, GRAPH_SUMMARY_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { GraphData } from "@/types";

export function useGraphData() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();
  // 请求身份守卫：并发 fetchGraph 时，旧调用的迟到响应（含 finally）不得
  // 写坏新一轮调用的 state。与 abort 的分工见 hook 文档。
  const { begin, isStale } = useStaleGuard();

  /**
   * 异步获取知识图谱数据（两步：摘要 → 图谱）。
   * @param text - 原文文本
   * @param historyId - history 记录 ID，用于更新 graph_data 字段
   */
  const fetchGraph = useCallback(
    async (text: string, historyId?: number) => {
      abort();
      const signal = getSignal();
      // begin() 之后本调用成为所有者：后续任何 fetchGraph 都会使它过期
      const seq = begin();

      // 不变量：本函数每一次 state 写入前都先做过期自检——迟到结果一律
      // 挡在新一轮 UI 之外（含下方 finally 与无模型早退路径）
      if (!isStale(seq)) {
        setGraphLoading(true);
        setGraphError(null);
      }

      const model = await getDefaultModelCached();
      if (!model?.api_key) {
        // 未配置模型必须显式报错：此前静默返回，图谱区无任何反馈
        if (isStale(seq)) return;
        setGraphError("请先配置 LLM 模型后再生成知识图谱。");
        setGraphLoading(false);
        return;
      }

      try {
        // ── 第一步：将长文章压缩为关键概念摘要 ──
        const MAX_SUMMARY_INPUT = 12000;
        const summaryInput =
          text.length > MAX_SUMMARY_INPUT ? text.slice(0, MAX_SUMMARY_INPUT) : text;
        const summaryMessages = buildPrompt(GRAPH_SUMMARY_PROMPT, summaryInput);
        const summary = await streamChatAsync(summaryMessages, model, signal, 120_000);

        if (signal.aborted) return;

        // ── 第二步：从摘要生成知识图谱 ──
        const graphMessages = buildPrompt(GRAPH_DATA_PROMPT, summary);
        const graphText = await streamChatAsync(graphMessages, model, signal, 180_000);

        if (signal.aborted) return;

        // 过期调用连解析都不必做，直接丢弃
        if (isStale(seq)) return;

        // M5: 使用集中管理的 Zod schema 校验，替代无 validator 的 extractJson
        const parsed = extractJsonSafe(graphText, GraphDataSchema);
        if (parsed) {
          setGraphData(parsed);
          if (historyId != null && historyId > 0) {
            // 持久化失败降级为"仅内存态"：当前会话图谱仍可用，但重启后丢失。
            // 必须 catch：此前是浮动 Promise，失败会产生 unhandled rejection
            updateHistoryGraphData(historyId, JSON.stringify(parsed)).catch((err) => {
              console.warn("[graph] persist graph_data failed:", err);
            });
          }
        } else {
          setGraphError("图谱数据解析失败");
          console.warn("[graph] parse failed:", graphText);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (isStale(seq)) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setGraphError(err.message);
        console.warn("[graph] fetch failed:", err);
      } finally {
        // H2: 取消路径仍正确——被取消的调用若仍是最新（没有新 fetch 接手），
        // 其 finally 照常清 loading，不会永久卡在加载中；若已有新 fetch 接管
        // （序号已过期），loading 归新调用所有，旧调用不得清零。
        // clearGraph/cancelGraph 各自显式管理状态，不经此路径。
        if (!isStale(seq)) {
          setGraphLoading(false);
        }
      }
    },
    [abort, getSignal, begin, isStale],
  );

  /** 清空图谱数据、错误状态和加载状态。 */
  const clearGraph = useCallback(() => {
    setGraphData(null);
    setGraphError(null);
    setGraphLoading(false);
  }, []);

  /** 取消正在进行的图谱生成请求。 */
  const cancelGraph = useCallback(() => {
    abort();
  }, [abort]);

  return { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph };
}
