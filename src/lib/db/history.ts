/**
 * 历史记录操作。
 */

import { invoke } from "@tauri-apps/api/core";
import { getErrorMessage } from "@/lib/error-utils";
import { extractJsonSafe } from "@/lib/parse-utils";
import { CorrectionResultSchema } from "@/lib/schemas";
import type { HistoryRecord } from "@/types";
import { aggregateCorrections } from "./utils";

/**
 * 新增一条学习历史记录。
 *
 * 所有 LLM 页面（CorrectPage、ReadingPage、ExercisePage、ListeningPage、SpeakingPage）
 * 在完成任务后调用此函数持久化结果。
 *
 * @param record - 历史记录数据（不含 id、created_at，graph_data 可选）
 * @returns 包含 lastInsertId 的对象
 */
export async function addHistory(
  record: Omit<HistoryRecord, "id" | "created_at" | "graph_data"> & { graph_data?: string | null },
) {
  const lastInsertId = await invoke<number>("db_add_history", {
    recordType: record.type,
    inputText: record.input_text,
    result: record.result,
    graphData: record.graph_data ?? null,
  });
  return { lastInsertId };
}

/**
 * 安全版本的历史记录写入 —— 失败时调用 onError 回调而非抛出异常。
 *
 * 用于页面组件中需要容错的场景（如 CorrectPage、ReadingPage），避免保存失败
 * 阻塞用户继续操作。
 *
 * @param record - 历史记录数据
 * @param onError - 可选的错误回调（显示 ErrorBanner 用）
 * @returns 写入成功返回 lastInsertId，失败返回 null
 */
export async function addHistorySafe(
  record: Parameters<typeof addHistory>[0],
  onError?: (msg: string) => void,
): Promise<number | null> {
  try {
    const result = await addHistory(record);
    return result.lastInsertId ?? null;
  } catch (e) {
    const msg = `保存失败: ${getErrorMessage(e)}`;
    console.warn(msg);
    onError?.(msg);
    return null;
  }
}

/**
 * 更新历史记录的知识图谱数据。
 *
 * 在异步生成知识图谱完成后调用，将图谱 JSON 写入 history 表的 graph_data 字段。
 *
 * @param id - 历史记录 ID
 * @param graphData - 知识图谱 JSON 字符串
 */
export async function updateHistoryGraphData(id: number, graphData: string) {
  return invoke<void>("db_update_history_graph_data", { id, graphData });
}

/**
 * 查询历史记录列表（含完整字段：id, type, input_text, result, graph_data, created_at）。
 *
 * 支持按记录类型过滤和分页。用于 AnalyticsPage 需要读取完整 result 字段时。
 * 如仅需列表视图（不含 result 和 graph_data），请使用 getHistoryList。
 *
 * @param types - 可选的记录类型过滤（单个字符串或数组）
 * @param limit - 可选的分页大小
 * @param offset - 可选的分页偏移
 * @param signal - 可选的 AbortSignal（用于取消请求）
 * @returns 历史记录数组
 */
export async function getHistory(
  types?: string | string[],
  limit?: number,
  offset?: number,
  signal?: AbortSignal,
): Promise<HistoryRecord[]> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const recordTypes = types ? (Array.isArray(types) ? types : [types]) : null;
  return invoke<HistoryRecord[]>("db_get_history", {
    recordTypes,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

/**
 * Lightweight history list query — excludes the heavy `result` and `graph_data` columns.
 * Use this for the list view where only id, type, input_text, and created_at are needed.
 */
export async function getHistoryList(
  types?: string | string[],
  limit?: number,
  offset?: number,
): Promise<HistoryRecord[]> {
  const recordTypes = types ? (Array.isArray(types) ? types : [types]) : null;
  return invoke<HistoryRecord[]>("db_get_history_list", {
    recordTypes,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

/**
 * 查询最早历史记录的创建时间。
 * 用于 Dashboard 计算"已使用 N 天"，仅传输单条时间戳。
 */
export async function getHistoryOldestDate(): Promise<string | null> {
  return invoke<string | null>("db_get_history_oldest_date");
}

/** 按 id 关联的历史 result 对 —— getHistoryResultsByType 的返回元素。 */
export interface HistoryResultRef {
  /** 历史记录 ID，用于与轻量记录列表（getHistoryList）精确配对 */
  id: number;
  /** LLM 返回的原始 result 字符串 */
  result: string;
}

/**
 * 按类型集合查询历史记录的 (id, result) 对（不含其他字段）。
 * 用于 AnalyticsPage / Dashboard 按需获取需要解析的 result 内容，减少 IPC 数据量。
 *
 * 返回 id 以便调用方与记录列表按 id 关联 —— 不要依赖返回顺序与记录列表一致
 * （两次查询间隙可能插入新记录、且存在 legacy type 值），按下标配对会错位。
 *
 * @param recordTypes - 记录类型（单个字符串或数组；写作场景传
 *   `["correct", "writing"]` 以兼容历史数据中两种 type 值）
 * @param limit - 最大返回条数
 */
export async function getHistoryResultsByType(
  recordTypes: string | string[],
  limit: number,
): Promise<HistoryResultRef[]> {
  const types = Array.isArray(recordTypes) ? recordTypes : [recordTypes];
  return invoke<HistoryResultRef[]>("db_get_history_results_by_type", {
    recordTypes: types,
    limit,
  });
}

/**
 * 根据 ID 查询单条历史记录（含完整字段）。
 *
 * @param id - 历史记录 ID
 * @returns 记录对象，不存在时返回 null
 */
export async function getHistoryById(id: number): Promise<HistoryRecord | null> {
  return invoke<HistoryRecord | null>("db_get_history_by_id", { id });
}

/**
 * 删除指定历史记录。
 *
 * @param id - 要删除的记录 ID
 */
export async function deleteHistory(id: number) {
  return invoke<void>("db_delete_history", { id });
}

/**
 * 查询最近的写作批改记录 result 字段（不含其他列）。
 * 用于 Dashboard 弱项分析，直接返回原始 JSON 字符串供调用方解析。
 */
export async function getRecentCorrectResults(maxRecords = 20): Promise<string[]> {
  return invoke<string[]>("db_get_recent_correct_results", { maxRecords });
}

/**
 * 构建个性化的用户学习上下文。
 * 查询最近的历史记录，提取高频错误类别和典型错误示例，
 * 用于注入 LLM prompt 以提升分析质量。
 */
export async function buildPersonalizedContext(maxRecords = 20): Promise<string> {
  try {
    const results = await invoke<string[]>("db_get_recent_correct_results", { maxRecords });
    if (results.length < 3) return "";

    // H-4: 使用 Zod schema 进行运行时校验，然后委托纯函数聚合
    const parsed = results
      .map((r) => extractJsonSafe(r, CorrectionResultSchema))
      .filter((r): r is NonNullable<typeof r> => r != null);

    return aggregateCorrections(parsed);
  } catch (e) {
    console.warn("[db] buildPersonalizedContext failed:", e);
    return "";
  }
}
