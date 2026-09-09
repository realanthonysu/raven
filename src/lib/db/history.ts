/**
 * 历史记录操作。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
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
 * 原始写入仅由 Safe 包装器内部使用，不再经 db barrel（@/lib/db）对外导出；
 * 测试如需覆盖请从本模块（@/lib/db/history）直接导入。
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
interface HistoryResultRef {
  /** 历史记录 ID，用于与轻量记录列表（getHistoryList）精确配对 */
  id: number;
  /** LLM 返回的原始 result 字符串 */
  result: string;
}

/**
 * 按类型集合查询历史记录的 (id, result) 对（不含其他字段）。
 * getHistoryWithResults 内部的 result 拉取通道（不经 db barrel 对外导出）。
 *
 * 返回 id 以便调用方与记录列表按 id 关联 —— 不要依赖返回顺序与记录列表一致
 * （两次查询间隙可能插入新记录、且存在 legacy type 值），按下标配对会错位。
 *
 * @param recordTypes - 记录类型（单个字符串或数组；写作场景传
 *   `["correct", "writing"]` 以兼容历史数据中两种 type 值）
 * @param limit - 最大返回条数
 */
async function getHistoryResultsByType(
  recordTypes: string | string[],
  limit: number,
): Promise<HistoryResultRef[]> {
  const types = Array.isArray(recordTypes) ? recordTypes : [recordTypes];
  return invoke<HistoryResultRef[]>("db_get_history_results_by_type", {
    recordTypes: types,
    limit,
  });
}

/** getHistoryWithResults 的返回结构 —— 轻量记录 + 已按 id 配对好的 result 内容。 */
export interface HistoryWithResults {
  /** 轻量历史记录（不含 result/graph_data），按 created_at **降序（最新在前）**排列 */
  records: HistoryRecord[];
  /**
   * 记录 id → result 原始字符串。**必须按记录 id 取用** —— 不要按下标配对
   * （两次查询间隙可能插入新记录、且存在 legacy type 值，下标配对会错位）。
   * 某条记录的 result 缺失（含 results 查询失败的 fail-soft 场景）时由调用方回退。
   */
  resultById: Map<number, string>;
}

/**
 * 一次取回「轻量记录 + 对应 result」，并在数据层完成按 id 配对。
 *
 * 收敛此前 Dashboard / useAnalytics 各自手写的两段式查询协议
 * （getHistoryList 拿轻量记录 → getHistoryResultsByType 拿 (id, result) 对 →
 * 手工建 Map 关联），调用方只需消费 { records, resultById }。
 *
 * 契约（重要）：
 * - `records` 为轻量记录，按 created_at **降序（最新在前）**返回；
 *   时间序统计必须基于记录的 `created_at` 字段显式排序推导，
 *   **不要把数组顺序当作时间语义使用**。
 * - `resultById` 以记录 id 为键；result 缺失时调用方自行回退
 *   （如回退到 record.result 或默认展示文案）。
 * - **fail-soft**：results 查询失败时 `resultById` 退化为空 Map，
 *   records 照常返回（沿用 useAnalytics 的 catch-and-continue 降级语义）；
   仅当记录列表本身查询失败时整个 Promise 才 reject。
 *
 * @param recordTypes - 记录类型（单个字符串或数组；写作场景传
 *   `["correct", "writing"]` 以兼容历史数据中两种 type 值），
 *   用于轻量记录查询（records 返回这些类型的所有记录）
 * @param limit - 记录列表最大返回条数（不传时两侧均取 Rust 端默认上限 100）
 * @param resultTypes - 可选的结果类型集合（仅对这些类型拉取重型 result 列），
 *   默认等于 recordTypes（保持向后兼容）。用于「记录元数据要包含某类型、但 result
 *   无需解析」的场景（如 reading 的重型 Markdown result 只供详情页展示，
 *   分析页不应拉取），避免把重型列带进 IPC。
 * @param resultLimit - 可选的 result 查询上限（默认等于 `limit`）。
 *   元数据需要较大窗口（如 Analytics 500 条）而重型 result 只需最近一批时，
 *   可用更小的 resultLimit 压低 IPC 载荷；未配到 result 的旧记录按缺失处理。
 */
export async function getHistoryWithResults(
  recordTypes: string | string[],
  limit?: number,
  resultTypes?: string[],
  resultLimit?: number,
): Promise<HistoryWithResults> {
  const types = Array.isArray(recordTypes) ? recordTypes : [recordTypes];
  // 默认共用同一上限：保证"最新 N 条记录"与"最新 N 条 result"来自同一窗口，
  // 按 id 配对不会出现单侧缺块
  const effectiveLimit = limit ?? 100;
  const effectiveResultLimit = resultLimit ?? effectiveLimit;
  const [records, refs] = await Promise.all([
    getHistoryList(types, effectiveLimit),
    // fail-soft：result 获取失败不阻塞记录列表返回（空 Map 由调用方按缺失处理）
    getHistoryResultsByType(resultTypes ?? types, effectiveResultLimit).catch(
      () => [] as HistoryResultRef[],
    ),
  ]);
  return { records, resultById: new Map(refs.map((r) => [r.id, r.result])) };
}

/**
 * 根据 ID 查询单条历史记录（含 result，不含 graph_data）。
 *
 * @param id - 历史记录 ID
 * @returns 记录对象，不存在时返回 null
 */
export async function getHistoryById(id: number): Promise<HistoryRecord | null> {
  return invoke<HistoryRecord | null>("db_get_history_by_id", { id });
}

/**
 * 按 ID 单独读取知识图谱 JSON（阅读详情专用）。
 * 非阅读记录的 graph_data 为空，调用方无需发起本查询。
 */
export async function getHistoryGraphData(id: number): Promise<string | null> {
  return invoke<string | null>("db_get_history_graph_data", { id });
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
 * buildPersonalizedContext 的数据源（不经 db barrel 对外导出），
 * 直接返回原始 JSON 字符串供调用方解析。
 */
async function getRecentCorrectResults(maxRecords = 20): Promise<string[]> {
  return invoke<string[]>("db_get_recent_correct_results", { maxRecords });
}

/**
 * 个性化上下文缓存：每次写作提交都会查最近 20 条并 Zod 解析。
 * 60s 内的连续提交复用同一结果，避免 IPC + 解析开销（写完一篇再写另一篇
 * 通常在几分钟后，TTL 足够覆盖同会话连发）。
 */
const personalizedContextCache = createCachedFetcher(
  async (maxRecords: number): Promise<string> => {
    try {
      const results = await getRecentCorrectResults(maxRecords);
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
  },
  {
    maxSize: 4,
    keyFn: (maxRecords: number) => String(maxRecords),
    ttlMs: 60_000,
  },
);

/**
 * 构建个性化的用户学习上下文。
 * 查询最近的历史记录，提取高频错误类别和典型错误示例，
 * 用于注入 LLM prompt 以提升分析质量。
 *
 * 结果经 TTL 缓存（见 personalizedContextCache）；测试可通过
 * `invalidatePersonalizedContextCache` 清空。
 */
export async function buildPersonalizedContext(maxRecords = 20): Promise<string> {
  return personalizedContextCache.cached(maxRecords);
}

/** 测试辅助：清空个性化上下文缓存。 */
export function invalidatePersonalizedContextCache(): void {
  personalizedContextCache.invalidate();
}
