/**
 * useGraphData hook tests.
 *
 * Mock @/services/llm（buildPrompt/streamChatAsync）与 @/lib/db
 * （getDefaultModelCached/updateHistoryGraphData），覆盖两步生成成功路径、
 * 解析失败、无模型早退，以及并发/取消场景下的 stale-response 守卫：
 * 被取代的旧调用（superseded outcome）不得清零新调用的 loading，
 * 迟到错误不得写进新 UI。单飞管线由 useLlmTask 承载（另有独立单测），
 * 本文件断言落在 outcome → state 的映射行为上。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultModelCached, updateHistoryGraphData } from "@/lib/db";
import type { GraphData, ModelConfig } from "@/types";
import { useGraphData } from "./use-graph-data";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn(),
  updateHistoryGraphData: vi.fn(),
}));

const MODEL: ModelConfig = {
  id: 1,
  name: "test-model",
  api_key: "sk-test-key",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** 合法图谱 JSON（匹配 GraphDataSchema） */
function graphJson(): string {
  return JSON.stringify({
    nodes: [{ id: "a", label: "概念A", labelEn: "Concept A", type: "concept" }],
    edges: [{ source: "a", target: "a", relation: "关联" }],
  });
}

const EXPECTED_GRAPH: GraphData = {
  nodes: [{ id: "a", label: "概念A", labelEn: "Concept A", type: "concept" }],
  edges: [{ source: "a", target: "a", relation: "关联" }],
};

/** AbortError（与 use-abortable.test.ts 同款构造） */
function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/** 外部可控的 Promise，用于精确编排乱序返回时序 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 迟到的 stream：signal 触发 abort 时 reject，否则永不 settle */
function abortableStream(signal?: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

describe("useGraphData", () => {
  beforeEach(() => {
    // resetAllMocks：mockClear 不清除 mockImplementationOnce 队列，失败测试
    // 残留的一次性实现会污染后续测试（本文件重度依赖 once 时序编排）
    vi.resetAllMocks();
    vi.mocked(getDefaultModelCached).mockResolvedValue(MODEL);
    vi.mocked(updateHistoryGraphData).mockResolvedValue(undefined);
  });

  // ── 基本路径 ──────────────────────────────────────────────────────

  it("fetches graph data in two steps, persists it and clears loading", async () => {
    mockStreamChatAsync.mockResolvedValueOnce("summary").mockResolvedValueOnce(graphJson());

    const { result } = renderHook(() => useGraphData());

    await act(async () => {
      await result.current.fetchGraph("some article", 42);
    });

    // 两步：摘要 → 图谱
    expect(mockStreamChatAsync).toHaveBeenCalledTimes(2);
    expect(result.current.graphData).toEqual(EXPECTED_GRAPH);
    expect(result.current.graphError).toBeNull();
    expect(result.current.graphLoading).toBe(false);
    expect(updateHistoryGraphData).toHaveBeenCalledWith(42, JSON.stringify(EXPECTED_GRAPH));
  });

  it("reports an explicit error when no model is configured", async () => {
    vi.mocked(getDefaultModelCached).mockResolvedValue(null);

    const { result } = renderHook(() => useGraphData());

    await act(async () => {
      await result.current.fetchGraph("text");
    });

    expect(result.current.graphError).toBe("请先配置 LLM 模型后再生成知识图谱。");
    expect(result.current.graphLoading).toBe(false);
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  it("reports a parse error when the graph JSON is invalid", async () => {
    mockStreamChatAsync.mockResolvedValueOnce("summary").mockResolvedValueOnce("not json at all");

    const { result } = renderHook(() => useGraphData());

    await act(async () => {
      await result.current.fetchGraph("text");
    });

    expect(result.current.graphError).toBe("图谱数据解析失败");
    expect(result.current.graphLoading).toBe(false);
  });

  // ── stale-response 守卫（H2 修复） ─────────────────────────────────

  it("keeps the second fetch's loading when the first fetch's finally lands late", async () => {
    // 并发场景：第二次 fetchGraph 发起（abort + begin）后，第一次的 catch/
    // finally 迟到返回——不得清零第二次的 loading，也不得写旧错误
    const firstSummary = deferred<string>();
    const secondSummary = deferred<string>();
    const secondGraph = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstSummary.promise)
      .mockImplementationOnce(() => secondSummary.promise)
      .mockImplementationOnce(() => secondGraph.promise);

    const { result } = renderHook(() => useGraphData());

    // 第一次：进入两步流程，摘要 stream 在途
    let first!: Promise<void>;
    act(() => {
      first = result.current.fetchGraph("text-1");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    // 第二次：abort 第一次并 begin（序号 +1），自身进入流程
    let second!: Promise<void>;
    act(() => {
      second = result.current.fetchGraph("text-2");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    // 第一次的摘要 stream 迟到失败（signal 已被第二次 abort）
    await act(async () => {
      firstSummary.reject(abortError());
      await first;
    });

    // 核心断言：第一次的 finally 没有清零第二次的 loading，也没有写错误
    expect(result.current.graphLoading).toBe(true);
    expect(result.current.graphError).toBeNull();

    // 第二次正常完成，状态归它所有
    await act(async () => {
      secondSummary.resolve("summary-2");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(3));

    await act(async () => {
      secondGraph.resolve(graphJson());
      await second;
    });

    expect(result.current.graphData).toEqual(EXPECTED_GRAPH);
    expect(result.current.graphLoading).toBe(false);
    expect(result.current.graphError).toBeNull();
  });

  it("drops a stale no-model error into the newer fetch's UI", async () => {
    // 第一次卡在模型查询窗口，第二次已配置模型并进入流程；第一次迟到解析出
    // "未配置模型"时——已被取代，报错与 loading 清零都必须丢弃
    const firstModel = deferred<typeof MODEL | null>();
    vi.mocked(getDefaultModelCached).mockImplementationOnce(() => firstModel.promise);
    // 第二次的两步流程各需一路在途 stream
    const secondSummary = deferred<string>();
    const secondGraph = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => secondSummary.promise)
      .mockImplementationOnce(() => secondGraph.promise);

    const { result } = renderHook(() => useGraphData());

    act(() => {
      void result.current.fetchGraph("text-1");
    });
    await waitFor(() => expect(getDefaultModelCached).toHaveBeenCalledTimes(1));

    // 第二次发起：模型查询立即返回 MODEL，进入 stream 阶段
    act(() => {
      void result.current.fetchGraph("text-2");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.graphLoading).toBe(true);

    // 第一次的模型查询迟到返回 null（未配置）：序号已过期，整体丢弃
    await act(async () => {
      firstModel.resolve(null);
      // 冲刷微任务，让第一次走到无模型早退分支
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 核心断言：旧调用的报错没有落进新一轮 UI，loading 也未归零
    expect(result.current.graphError).toBeNull();
    expect(result.current.graphLoading).toBe(true);

    // 第二次正常完成（两步：摘要 → 图谱）
    await act(async () => {
      secondSummary.resolve("summary-2");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondGraph.resolve(graphJson());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.graphData).toEqual(EXPECTED_GRAPH);
    expect(result.current.graphLoading).toBe(false);
    expect(result.current.graphError).toBeNull();
  });

  // ── 取消路径 ──────────────────────────────────────────────────────

  it("cancelGraph clears loading via the cancelled call's finally", async () => {
    // 取消路径仍正确：cancelGraph 不 begin（序号未变），被取消的调用若仍是
    // 最新（没有新 fetch 接手），其 finally 照常清 loading，不会永久卡住
    let capturedSignal: AbortSignal | undefined;
    mockStreamChatAsync.mockImplementationOnce(
      (_messages: unknown, _model: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return abortableStream(signal);
      },
    );

    const { result } = renderHook(() => useGraphData());

    act(() => {
      void result.current.fetchGraph("text");
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));
    expect(result.current.graphLoading).toBe(true);

    act(() => {
      result.current.cancelGraph();
    });
    expect(capturedSignal?.aborted).toBe(true);

    // abort 事件可能异步派发：冲刷任务队列让被取消的调用 settle 到 finally
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.graphLoading).toBe(false);
    // 中止不是失败：不得借机写入错误
    expect(result.current.graphError).toBeNull();
  });
});
