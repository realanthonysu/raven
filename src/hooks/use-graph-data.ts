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
import { getDefaultModel, updateHistoryGraphData } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { GRAPH_DATA_PROMPT, GRAPH_SUMMARY_PROMPT } from "@/prompts";
import { buildPrompt, streamChat } from "@/services/llm";

interface GraphData {
  nodes: { id: string; label: string; type: string }[];
  edges: { source: string; target: string; relation: string }[];
}

/** 用 Promise 包装 streamChat，支持 async/await 顺序调用 */
function streamChatAsync(
  messages: Parameters<typeof streamChat>[0],
  model: Parameters<typeof streamChat>[1],
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    streamChat(
      messages,
      model,
      {
        onToken: () => {},
        onDone: (text) => resolve(text),
        onError: (err) => reject(err),
      },
      signal,
      timeoutMs,
    );
  });
}

export function useGraphData() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const { abort, getSignal } = useAbortable();

  /**
   * 异步获取知识图谱数据（两步：摘要 → 图谱）。
   * @param text - 原文文本
   * @param historyId - history 记录 ID，用于更新 graph_data 字段
   */
  const fetchGraph = useCallback(
    async (text: string, historyId?: number) => {
      abort();
      const signal = getSignal();

      setGraphLoading(true);
      setGraphError(null);

      const model = await getDefaultModel();
      if (!model?.api_key) {
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

        const parsed = extractJson<GraphData>(graphText);
        if (parsed) {
          setGraphData(parsed);
          if (historyId != null && historyId > 0) {
            updateHistoryGraphData(historyId, JSON.stringify(parsed));
          }
        } else {
          setGraphError("图谱数据解析失败");
          console.warn("[graph] parse failed:", graphText);
        }
      } catch (error) {
        if (signal.aborted) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setGraphError(err.message);
        console.warn("[graph] fetch failed:", err);
      } finally {
        if (!signal.aborted) setGraphLoading(false);
      }
    },
    [abort, getSignal],
  );

  const clearGraph = useCallback(() => {
    setGraphData(null);
    setGraphError(null);
    setGraphLoading(false);
  }, []);

  const cancelGraph = useCallback(() => {
    abort();
  }, [abort]);

  return { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph };
}
