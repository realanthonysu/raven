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
import { z } from "zod";
import { useAbortable } from "@/hooks/use-abortable";
import { getDefaultModelCached, updateHistoryGraphData } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { GRAPH_DATA_PROMPT, GRAPH_SUMMARY_PROMPT } from "@/prompts";
import { buildPrompt, streamChatAsync } from "@/services/llm";

/** 知识图谱数据结构。 */
interface GraphData {
  /** 图谱节点列表 */
  nodes: { id: string; label: string; labelEn?: string; type: string }[];
  /** 图谱边（关系）列表 */
  edges: { source: string; target: string; relation: string }[];
}

// M5: GraphData 的 Zod schema，用于运行时校验 LLM 返回的 JSON
// L4: 包含 labelEn 字段，与 GRAPH_DATA_PROMPT 要求一致
const GraphDataSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      labelEn: z.string().optional(),
      type: z.string(),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      relation: z.string(),
    }),
  ),
});

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

      const model = await getDefaultModelCached();
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

        // M5: 使用 Zod schema 校验，替代无 validator 的 extractJson
        const parsed = extractJson<GraphData>(
          graphText,
          (d) => GraphDataSchema.safeParse(d).success,
        );
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
        // H2: 无论是否中止，都应重置 loading 状态，避免永久卡在加载中
        setGraphLoading(false);
      }
    },
    [abort, getSignal],
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
