/**
 * useGraphData —— 封装知识图谱的 LLM 生成和状态管理。
 *
 * ReadingPage 在六维分析完成后异步调用此 hook 生成概念关系图谱，
 * 不阻塞主流程。成功后同时更新 React state 和 SQLite history 表。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { streamChat, buildPrompt } from "@/services/llm";
import { getDefaultModel, updateHistoryGraphData } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { GRAPH_DATA_PROMPT } from "@/prompts";

interface GraphData {
  nodes: { id: string; label: string; type: string }[];
  edges: { source: string; target: string; relation: string }[];
}

export function useGraphData() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort pending request on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  /**
   * 异步获取知识图谱数据。
   * @param text - 原文文本
   * @param historyId - history 记录 ID，用于更新 graph_data 字段
   */
  const fetchGraph = useCallback(async (text: string, historyId?: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGraphLoading(true);
    setGraphError(null);

    const model = await getDefaultModel();
    if (!model?.api_key) { setGraphLoading(false); return; }

    const messages = buildPrompt(GRAPH_DATA_PROMPT, text);
    await streamChat(messages, model, {
      onToken: () => {},
      onDone: (fullText) => {
        if (controller.signal.aborted) return;
        const parsed = extractJson<GraphData>(fullText);
        if (parsed) {
          setGraphData(parsed);
          if (historyId != null && historyId > 0) {
            updateHistoryGraphData(historyId, JSON.stringify(parsed));
          }
        } else {
          setGraphError("图谱数据解析失败");
          console.warn("[graph] parse failed:", fullText);
        }
        setGraphLoading(false);
      },
      onError: (error) => {
        if (controller.signal.aborted) return;
        setGraphError(error.message);
        setGraphLoading(false);
        console.warn("[graph] fetch failed:", error);
      },
    }, controller.signal);
  }, []);

  const clearGraph = useCallback(() => {
    setGraphData(null);
  }, []);

  const cancelGraph = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { graphData, graphLoading, graphError, fetchGraph, clearGraph, cancelGraph };
}
