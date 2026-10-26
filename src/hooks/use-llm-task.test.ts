/**
 * useLlmTask —— 旁路 LLM 任务单飞原语的单元测试。
 *
 * mock @/services/llm 的 streamChatAsync 与 @/lib/db 的 getDefaultModelCached，
 * 覆盖 outcome 六态：parsed / parse-failed / error / not-configured（含自定义
 * 文案路径——文案经 outcome 外传由调用方展示，原语断言 status 与 message）/
 * aborted（cancel）/ superseded（两次 run 的乱序收尾，含成功结果被压制），
 * 以及"run 永不 reject"的深模块承诺（buildText 抛非 abort 异常、模型加载
 * 失败均归一为 error outcome）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDefaultModelCached } from "@/lib/db";
import type { ModelConfig } from "@/types";
import { type LlmTaskOutcome, type LlmTaskRunContext, useLlmTask } from "./use-llm-task";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "./use-stream-chat";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  // use-stream-chat（MODEL_NOT_CONFIGURED_MESSAGE 的来源模块）加载时引用，
  // 原语本身不调用
  streamChat: vi.fn(),
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn(),
}));

const MODEL: ModelConfig = {
  id: 1,
  name: "test-model",
  api_key: "sk-test-key",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** 最小 payload schema，与流式文本格式对齐 */
const PayloadSchema = z.object({ value: z.string() });
type Payload = z.infer<typeof PayloadSchema>;

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

/** 在途 stream：signal 触发 abort 时 reject AbortError，否则由外部控制 settle */
function abortableStream(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/** 模拟真实单步流式的 buildText：经 mockStreamChatAsync 转发 ctx */
function streamStep(ctx: LlmTaskRunContext): Promise<string> {
  return mockStreamChatAsync("messages", ctx.model, ctx.signal);
}

describe("useLlmTask", () => {
  beforeEach(() => {
    // resetAllMocks：mockClear 不清除 mockImplementationOnce 队列，失败测试
    // 残留的一次性实现会污染后续测试（本文件重度依赖 once 时序编排）
    vi.resetAllMocks();
    vi.mocked(getDefaultModelCached).mockResolvedValue(MODEL);
  });

  // ── 成功与解析 ────────────────────────────────────────────────────

  it("returns parsed data and passes the resolved model/signal to buildText", async () => {
    mockStreamChatAsync.mockResolvedValue('{"value":"ok"}');

    const { result } = renderHook(() => useLlmTask<Payload>());

    // 对象 holder：闭包内赋值不被 TS 的控制流分析追踪，直接断言会收窄成 never
    const ctxHolder: { current: LlmTaskRunContext | null } = { current: null };
    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({
        buildText: (ctx) => {
          ctxHolder.current = ctx;
          return mockStreamChatAsync("messages", ctx.model, ctx.signal);
        },
        schema: PayloadSchema,
      });
    });

    expect(outcome).toEqual({ status: "parsed", data: { value: "ok" } });
    // 原语职责：模型解析收编——buildText 拿到的是解析好的模型与本次 signal
    expect(ctxHolder.current?.model).toEqual(MODEL);
    expect(ctxHolder.current?.signal).toBeInstanceOf(AbortSignal);
    expect(getDefaultModelCached).toHaveBeenCalledTimes(1);
  });

  it("returns parse-failed with the raw text when the schema rejects", async () => {
    mockStreamChatAsync.mockResolvedValue("not json at all");

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });

    expect(outcome).toEqual({ status: "parse-failed", rawText: "not json at all" });
  });

  // ── 永不 reject 的深模块承诺 ──────────────────────────────────────

  it("normalizes a non-abort buildText failure into an error outcome (never rejects)", async () => {
    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({
        buildText: async () => {
          throw new TypeError("unexpected boom");
        },
        schema: PayloadSchema,
      });
    });

    expect(outcome).toEqual({ status: "error", message: "unexpected boom" });
  });

  it("normalizes a stream failure into an error outcome", async () => {
    mockStreamChatAsync.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });

    expect(outcome).toEqual({ status: "error", message: "network down" });
  });

  it("normalizes a model-load failure into an error outcome", async () => {
    vi.mocked(getDefaultModelCached).mockRejectedValue(new Error("db down"));

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });

    expect(outcome).toEqual({ status: "error", message: "db down" });
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  // ── not-configured ────────────────────────────────────────────────

  it("returns not-configured with the canonical message when no model is configured", async () => {
    vi.mocked(getDefaultModelCached).mockResolvedValue(null);

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });

    // 文案经 outcome 外传由调用方展示；原语断言 status 与默认文案
    expect(outcome).toEqual({ status: "not-configured", message: MODEL_NOT_CONFIGURED_MESSAGE });
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  it("returns not-configured for a model without an api key", async () => {
    vi.mocked(getDefaultModelCached).mockResolvedValue({ ...MODEL, api_key: "" });

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });

    expect(outcome.status).toBe("not-configured");
  });

  it("propagates a custom not-configured message through the outcome", async () => {
    // 自定义文案路径（use-graph-data 的图谱文案经此保留）
    vi.mocked(getDefaultModelCached).mockResolvedValue(null);

    const { result } = renderHook(() => useLlmTask<Payload>());

    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await result.current.run({
        buildText: streamStep,
        schema: PayloadSchema,
        notConfiguredMessage: "请先配置 LLM 模型后再生成知识图谱。",
      });
    });

    expect(outcome).toEqual({
      status: "not-configured",
      message: "请先配置 LLM 模型后再生成知识图谱。",
    });
  });

  // ── 中止（cancel） ────────────────────────────────────────────────

  it("classifies a cancelled in-flight run as aborted", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStreamChatAsync.mockImplementation(
      (_messages: unknown, _model: unknown, signal?: AbortSignal) => {
        if (!signal) return Promise.reject(new Error("expected an abort signal"));
        capturedSignal = signal;
        return abortableStream(signal);
      },
    );

    const { result } = renderHook(() => useLlmTask<Payload>());

    let run!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      run = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.cancel();
    });
    expect(capturedSignal?.aborted).toBe(true);

    // abort 事件可能异步派发：冲刷任务队列让 buildText 的 AbortError 走到分类
    let outcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      outcome = await run;
    });

    expect(outcome).toEqual({ status: "aborted" });
  });

  // ── 单飞：superseded ──────────────────────────────────────────────

  it("marks the first run superseded when a second run starts", async () => {
    const firstStream = deferred<string>();
    const secondStream = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstStream.promise)
      .mockImplementationOnce(() => secondStream.promise);

    const { result } = renderHook(() => useLlmTask<Payload>());

    // 第一次 run 在途
    let first!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      first = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    // 第二次 run 取代第一次（abort + begin）
    let second!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      second = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    // 第一次迟到失败（signal 已被第二次 abort）
    await act(async () => {
      firstStream.reject(abortError());
    });
    let firstOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      firstOutcome = await first;
    });
    expect(firstOutcome).toEqual({ status: "superseded" });

    // 第二次正常完成
    await act(async () => {
      secondStream.resolve('{"value":"second"}');
    });
    let secondOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      secondOutcome = await second;
    });
    expect(secondOutcome).toEqual({ status: "parsed", data: { value: "second" } });
  });

  it("suppresses a stale success: a superseded run never delivers parsed", async () => {
    // 迟到的成功结果与迟到失败同罪：被取代后即使 payload 合法也不得按 parsed 交付
    const firstStream = deferred<string>();
    const secondStream = deferred<string>();
    mockStreamChatAsync
      .mockImplementationOnce(() => firstStream.promise)
      .mockImplementationOnce(() => secondStream.promise);

    const { result } = renderHook(() => useLlmTask<Payload>());

    // 第一次 run 在途
    let first!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      first = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    // 第二次 run 取代第一次（abort + begin）
    let second!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      second = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(2));

    // 第一次迟到成功（乱序）
    await act(async () => {
      firstStream.resolve('{"value":"stale"}');
    });
    let firstOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      firstOutcome = await first;
    });
    expect(firstOutcome).toEqual({ status: "superseded" });

    // 第二次正常完成
    await act(async () => {
      secondStream.resolve('{"value":"second"}');
    });
    let secondOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      secondOutcome = await second;
    });
    expect(secondOutcome).toEqual({ status: "parsed", data: { value: "second" } });
  });

  it("classifies a run superseded while waiting for model resolution", async () => {
    // 第一次卡在模型查询窗口，第二次已进入流程；第一次迟到解析出模型时
    // 已被取代——连 buildText 都不得发起
    const firstModel = deferred<ModelConfig | null>();
    vi.mocked(getDefaultModelCached).mockImplementationOnce(() => firstModel.promise);

    const secondStream = deferred<string>();
    mockStreamChatAsync.mockImplementationOnce(() => secondStream.promise);

    const { result } = renderHook(() => useLlmTask<Payload>());

    let first!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      first = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(getDefaultModelCached).toHaveBeenCalledTimes(1));

    let second!: Promise<LlmTaskOutcome<Payload>>;
    act(() => {
      second = result.current.run({ buildText: streamStep, schema: PayloadSchema });
    });
    await waitFor(() => expect(mockStreamChatAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstModel.resolve(MODEL);
    });
    let firstOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      firstOutcome = await first;
    });
    expect(firstOutcome).toEqual({ status: "superseded" });
    // 被取代的 run 不发起流式
    expect(mockStreamChatAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      secondStream.resolve('{"value":"second"}');
    });
    let secondOutcome!: LlmTaskOutcome<Payload>;
    await act(async () => {
      secondOutcome = await second;
    });
    expect(secondOutcome).toEqual({ status: "parsed", data: { value: "second" } });
  });
});
