/**
 * useGraphData —— 封装知识图谱的 LLM 生成和状态管理。
 *
 * 两步生成策略：
 * 1. 将长文章压缩为保留关键概念的简短摘要（避免 token 超限）
 * 2. 从摘要生成知识图谱 JSON（输入更短，响应更快，质量更好）
 *
 * ReadingPage 在六维分析完成后异步调用此 hook 生成概念关系图谱，
 * 不阻塞主流程。成功后同时更新 React state 和 SQLite history 表。
 *
 * 单飞管线（useAbortable + useStaleGuard + 模型解析 + 解析校验 + stale 自检）
 * 由 useLlmTask 原语承载，本 hook 只负责 outcome → state 的映射。
 */
import { useCallback, useState } from "react";
import { useLlmTask } from "@/hooks/use-llm-task";
import { updateHistoryGraphData } from "@/lib/db";
import { GraphDataSchema } from "@/lib/schemas";
import { GRAPH_DATA_PROMPT, GRAPH_SUMMARY_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";
import type { GraphData } from "@/types";

export function useGraphData() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const { run: runTask, cancel: cancelTask } = useLlmTask<GraphData>();

  /**
   * 异步获取知识图谱数据（两步：摘要 → 图谱）。
   * @param text - 原文文本
   * @param historyId - history 记录 ID，用于更新 graph_data 字段
   */
  const fetchGraph = useCallback(
    async (text: string, historyId?: number) => {
      setGraphLoading(true);
      setGraphError(null);

      const outcome = await runTask({
        buildText: async ({ model, signal }) => {
          // ── 第一步：将长文章压缩为关键概念摘要（避免 token 超限） ──
          const MAX_SUMMARY_INPUT = 12000;
          const summaryInput =
            text.length > MAX_SUMMARY_INPUT ? text.slice(0, MAX_SUMMARY_INPUT) : text;
          const summary = await streamChatAsync(
            buildPrompt(GRAPH_SUMMARY_PROMPT, summaryInput),
            model,
            signal,
            120_000,
          );
          // 中止语义：原样抛 AbortError，由原语归类为 aborted
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");

          // ── 第二步：从摘要生成知识图谱 ──
          return streamChatAsync(buildPrompt(GRAPH_DATA_PROMPT, summary), model, signal, 180_000);
        },
        // M5: 集中管理的 Zod schema 校验由原语的 extractJsonSafe 承载
        schema: GraphDataSchema,
        notConfiguredMessage: "请先配置 LLM 模型后再生成知识图谱。",
      });

      // loading 语义：仅任务所有者清零——superseded 任务的 outcome 在原语侧
      // 已被归类，不会走到任何 state 写（旧任务的迟到收尾既不清 loading 也
      // 不写错误，取代原 H2 finally 注释的自检实现）。
      if (outcome.status === "superseded") return;
      setGraphLoading(false);

      switch (outcome.status) {
        case "parsed": {
          setGraphData(outcome.data);
          if (historyId != null && historyId > 0) {
            // 持久化失败降级为"仅内存态"：当前会话图谱仍可用，但重启后丢失。
            // 必须 catch：此前是浮动 Promise，失败会产生 unhandled rejection
            updateHistoryGraphData(historyId, JSON.stringify(outcome.data)).catch((err) => {
              console.warn("[graph] persist graph_data failed:", err);
            });
          }
          break;
        }
        case "parse-failed":
          setGraphError("图谱数据解析失败");
          console.warn("[graph] parse failed:", outcome.rawText);
          break;
        case "error":
          setGraphError(outcome.message);
          console.warn("[graph] fetch failed:", outcome.message);
          break;
        case "not-configured":
          // 未配置模型必须显式报错：此前静默返回，图谱区无任何反馈
          setGraphError(outcome.message);
          break;
        case "aborted":
          // 中止不是失败：cancelGraph 路径不借机写入错误
          break;
      }
    },
    [runTask],
  );

  /** 清空图谱数据、错误状态和加载状态。 */
  const clearGraph = useCallback(() => {
    setGraphData(null);
    setGraphError(null);
    setGraphLoading(false);
  }, []);

  /** 取消正在进行的图谱生成请求（被取消的 run 若仍是所有者，outcome 为
   *  aborted，loading 由 outcome 映射路径清零）。 */
  const cancelGraph = useCallback(() => {
    cancelTask();
  }, [cancelTask]);

  return { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph };
}
