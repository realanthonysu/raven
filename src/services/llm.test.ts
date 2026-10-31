import { describe, expect, it, vi } from "vitest";

// A1: llm.ts 依赖 @tauri-apps/api/core 的 Channel/invoke(代理路径)。
// 默认让 invoke reject 以覆盖"代理不可用→降级"分支;代理行为用例在
// 各自用例内用 mockImplementation 覆盖
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
  invoke: vi.fn().mockRejectedValue(new Error("proxy unavailable in tests")),
}));

// llm.ts 的降级路径仍引用 smartFetch(http scope 收窄后仅本地回环供应商可用);
// smartFetch 被 mock,withTimeout/delayWithAbort 用真实实现(降级路径的等待逻辑依赖它们)
vi.mock("@/lib/fetch-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fetch-utils")>();
  return { ...actual, smartFetch: vi.fn() };
});

import { invoke } from "@tauri-apps/api/core";
import { smartFetch } from "@/lib/fetch-utils";
import type { ModelConfig } from "@/types";
import {
  buildPrompt,
  isLocalBaseUrl,
  readSSEStream,
  streamChat,
  TEST_LLM_CONNECTION_TIMEOUT_MS,
  testLLMConnection,
} from "./llm";

function makeStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const all = lines.join("\n\n");
  let position = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position >= all.length) {
        controller.close();
        return;
      }
      const chunk = all.slice(position, position + 32);
      position += chunk.length;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(stream);
}

describe("readSSEStream 单行事件解析", () => {
  // processSSELine 已删除(生产路径统一走 createSSEProcessor),
  // 其单行解析行为改由 readSSEStream 端到端覆盖。
  async function collect(lines: string[]) {
    const onToken = vi.fn();
    const onDone = vi.fn();
    await readSSEStream(makeStreamResponse(lines), { onToken, onDone });
    return { onToken, onDone };
  }

  it("emits token for valid data line", async () => {
    const { onToken, onDone } = await collect([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
    ]);
    expect(onToken).toHaveBeenCalledWith("Hello");
    expect(onDone).toHaveBeenCalledWith("Hello");
  });

  it("finishes on [DONE] marker", async () => {
    const { onToken, onDone } = await collect(["data: [DONE]", ""]);
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith("");
  });

  it("ignores non-data lines and malformed JSON", async () => {
    const { onToken, onDone } = await collect([
      ": heartbeat",
      "",
      "data: not-json",
      "",
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      "",
    ]);
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith("");
  });
});

describe("readSSEStream", () => {
  it("calls onToken for each chunk and onDone with full text", async () => {
    const onToken = vi.fn();
    const onDone = vi.fn();
    const response = makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      "data: [DONE]",
    ]);

    await readSSEStream(response, { onToken, onDone });

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, "Hello");
    expect(onToken).toHaveBeenNthCalledWith(2, " world");
    expect(onDone).toHaveBeenCalledWith("Hello world");
  });

  it("calls onDone even without [DONE] marker", async () => {
    const onToken = vi.fn();
    const onDone = vi.fn();
    const response = makeStreamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}']);

    await readSSEStream(response, { onToken, onDone });

    expect(onDone).toHaveBeenCalledWith("ok");
  });

  it("supports abort signal", async () => {
    const onToken = vi.fn();
    const onDone = vi.fn();
    const response = makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      'data: {"choices":[{"delta":{"content":"b"}}]}',
    ]);
    const controller = new AbortController();
    controller.abort();

    await readSSEStream(response, { onToken, onDone }, controller.signal);

    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("buildPrompt", () => {
  it("returns array with system and user messages", () => {
    const result = buildPrompt("You are helpful", "Hello");
    expect(result).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("preserves system prompt and user content", () => {
    const result = buildPrompt("Custom system prompt", "user input");
    expect(result[0].content).toBe("Custom system prompt");
    expect(result[0].role).toBe("system");
    expect(result[1].content).toBe("user input");
    expect(result[1].role).toBe("user");
  });

  it("returns exactly2 messages", () => {
    expect(buildPrompt("a", "b")).toHaveLength(2);
  });
});

describe("SSE spec compliance (P1 regression)", () => {
  async function collect(lines: string[]) {
    const onToken = vi.fn();
    const onDone = vi.fn();
    await readSSEStream(makeStreamResponse(lines), { onToken, onDone });
    return { onToken, onDone };
  }

  it("accepts 'data:' without a space before [DONE]", async () => {
    const { onToken, onDone } = await collect(["data:[DONE]", ""]);
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith("");
  });

  it("accepts 'data:' without a space before JSON payload", async () => {
    const { onToken } = await collect(['data:{"choices":[{"delta":{"content":"hi"}}]}', ""]);
    expect(onToken).toHaveBeenCalledWith("hi");
  });

  it("still accepts 'data: ' with a space", async () => {
    const { onToken } = await collect(['data: {"choices":[{"delta":{"content":"yo"}}]}', ""]);
    expect(onToken).toHaveBeenCalledWith("yo");
  });
});

describe("SSE multi-line data events (E1 regression)", () => {
  it("joins multi-line data fields into one event (spec semantics)", async () => {
    // 规范:同一事件的多行 data: 以 \n 拼接为一个 data 值。
    // 对 JSON 事件,拼接必然引入裸换行导致解析失败——代理/网关在 JSON
    // 内部切行属于破坏性改写;本用例验证:拼接行为存在、非法负载被安全
    // 忽略(不产生错误 token)、后续 [DONE] 事件仍正常定界
    const response = makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hel',
      'data: lo"}}]}',
      "",
      "data: [DONE]",
      "",
    ]);
    const tokens: string[] = [];
    let doneText = "";
    await readSSEStream(response, {
      onToken: (t) => tokens.push(t),
      onDone: (text) => {
        doneText = text;
      },
    });
    expect(tokens).toEqual([]);
    expect(doneText).toBe("");
  });

  it("blank line delimits events", async () => {
    const response = makeStreamResponse([
      'data: {"choices":[{"delta":{"content":"A"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"B"}}]}',
      "",
    ]);
    const tokens: string[] = [];
    await readSSEStream(response, {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
    });
    expect(tokens).toEqual(["A", "B"]);
  });
});

// ── testLLMConnection / isLocalBaseUrl ─────────────────────────────

describe("isLocalBaseUrl", () => {
  it("recognizes localhost / 127.0.0.1 / [::1] with port or path", () => {
    expect(isLocalBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalBaseUrl("http://[::1]:11434/v1")).toBe(true);
  });

  it("rejects remote https URLs", () => {
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalBaseUrl("https://api.deepseek.com/v1")).toBe(false);
  });
});

describe("testLLMConnection", () => {
  it("invokes test_llm_connection with baseUrl/apiKey/modelName and a bounded timeout", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    await testLLMConnection({
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-test",
      modelName: "gpt-4o-mini",
    });

    expect(invoke).toHaveBeenCalledWith("test_llm_connection", {
      // 尾斜杠归一化已移至 Rust 侧,前端原样透传
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-test",
      modelName: "gpt-4o-mini",
      // S-10: 前端等待边界同时下发给 Rust，避免前端放弃后主进程仍挂到 120s
      timeoutMs: TEST_LLM_CONNECTION_TIMEOUT_MS,
    });
  });

  it("passes empty apiKey for local services (auth-header omission is Rust-side)", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    await testLLMConnection({ baseUrl: "http://localhost:11434/v1", modelName: "llama3" });

    expect(invoke).toHaveBeenCalledWith(
      "test_llm_connection",
      expect.objectContaining({ apiKey: "" }),
    );
  });

  it("rejects immediately when the signal is already aborted (no IPC)", async () => {
    // S-10: 已中止的探活不发起请求，与 fetch 路径的 AbortError 语义一致
    vi.mocked(invoke).mockClear();
    const controller = new AbortController();
    controller.abort();

    await expect(
      testLLMConnection({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        modelName: "m",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects with AbortError when aborted while the probe is in flight", async () => {
    // invoke 无法取消命令：guardedInvoke 让调用方立刻返回，不再无限等待
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}) as Promise<never>);
    const controller = new AbortController();

    const pending = testLLMConnection({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      modelName: "m",
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });

  it("rejects with a readable timeout instead of hanging forever", async () => {
    // S-10: 前端等待边界。invoke 永不 settle 时必须在超时点拒绝
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}) as Promise<never>);

      const pending = testLLMConnection({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        modelName: "m",
      });
      const assertion = expect(pending).rejects.toThrow(
        `连接测试超时（${TEST_LLM_CONNECTION_TIMEOUT_MS / 1000}秒）`,
      );
      await vi.advanceTimersByTimeAsync(TEST_LLM_CONNECTION_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws with HTTP status when upstream responds non-2xx", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 401, body: "Unauthorized" });

    await expect(
      testLLMConnection({ baseUrl: "https://api.openai.com/v1", apiKey: "bad", modelName: "m" }),
    ).rejects.toThrow("HTTP 401");
  });

  it("throws when body is not a valid chat completion", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ unexpected: true }),
    });

    await expect(
      testLLMConnection({ baseUrl: "https://api.openai.com/v1", apiKey: "k", modelName: "m" }),
    ).rejects.toThrow("非预期的响应格式");
  });

  it("throws when body is not valid JSON (e.g. gateway error page)", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: "<html>gateway error</html>" });

    await expect(
      testLLMConnection({ baseUrl: "https://api.openai.com/v1", apiKey: "k", modelName: "m" }),
    ).rejects.toThrow("非预期的响应格式");
  });

  it("propagates proxy/network errors", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Network error"));

    await expect(
      testLLMConnection({ baseUrl: "https://api.openai.com/v1", apiKey: "k", modelName: "m" }),
    ).rejects.toThrow("Network error");
  });
});

// ── 代理路径 token 守卫(P1 回归):settled 后必须丢弃残余 Channel 事件 ──
// invoke 无法取消 Rust 侧命令,abort/done 之后 Channel 仍会投递事件;
// token 分支缺 settled 守卫会让旧请求的 token 继续写进页面状态。

interface CapturedChannel {
  onmessage:
    | ((event: { type: "token" | "done" | "error"; token?: string; message?: string }) => void)
    | null;
}

const proxyModel = {
  id: 1,
  name: "test",
  api_key: "",
  base_url: "https://api.example.com/v1",
  model_name: "test-model",
  is_default: true,
} as unknown as ModelConfig;

describe("proxyStreamChat settled guard (P1 regression)", () => {
  function captureChannel(): CapturedChannel[] {
    const channels: CapturedChannel[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: unknown, args: unknown) => {
      // cancel_stream_chat 没有 onEvent；只捕获流式命令的 Channel。
      if (cmd === "stream_chat_completions") {
        channels.push((args as { onEvent: CapturedChannel }).onEvent);
      }
      return null;
    });
    return channels;
  }

  it("passes a requestId to stream_chat_completions and calls cancel_stream_chat on abort", async () => {
    const calls: Array<{ cmd: unknown; args: Record<string, unknown> }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: unknown, args: unknown) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return null;
    });
    const controller = new AbortController();
    const finished = streamChat(
      buildPrompt("sys", "hi"),
      proxyModel,
      { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
      controller.signal,
    );

    const streamCall = calls.find((call) => call.cmd === "stream_chat_completions");
    expect(streamCall).toBeDefined();
    const requestId = streamCall?.args.requestId;
    expect(requestId).toEqual(expect.stringMatching(/^stream-/));

    controller.abort();
    await finished;

    expect(calls.find((call) => call.cmd === "cancel_stream_chat")?.args).toEqual({ requestId });
  });

  it("drops tokens/done/error arriving after abort", async () => {
    const channels = captureChannel();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const controller = new AbortController();

    const finished = streamChat(
      buildPrompt("sys", "hi"),
      proxyModel,
      { onToken, onDone, onError },
      controller.signal,
    );

    const channel = channels[0];
    channel.onmessage?.({ type: "token", token: "a" });
    controller.abort();
    // Rust 侧请求无法取消,这些事件仍会投递——必须被 settled 守卫丢弃
    channel.onmessage?.({ type: "token", token: "b" });
    channel.onmessage?.({ type: "done" });
    channel.onmessage?.({ type: "error", message: "late error" });

    await finished;

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("a");
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses locally accumulated tokens for onDone because Done carries no fullText (S-08)", async () => {
    const channels = captureChannel();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const finished = streamChat(buildPrompt("sys", "hi"), proxyModel, { onToken, onDone, onError });

    const channel = channels[0];
    // S-07 批处理下前端可能收到多条 token；S-08 的 Done 只带 type
    channel.onmessage?.({ type: "token", token: "Hello" });
    channel.onmessage?.({ type: "token", token: " world" });
    channel.onmessage?.({ type: "done" });
    // done 之后的残余 token 必须被丢弃
    channel.onmessage?.({ type: "token", token: "!" });

    await finished;

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("Hello world");
    expect(onError).not.toHaveBeenCalled();
  });

  it("completes with the local accumulation when Done arrives without any trailing token", async () => {
    const channels = captureChannel();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const finished = streamChat(buildPrompt("sys", "hi"), proxyModel, { onToken, onDone, onError });

    const channel = channels[0];
    channel.onmessage?.({ type: "token", token: "完整文本" });
    channel.onmessage?.({ type: "done" });

    await finished;

    expect(onDone).toHaveBeenCalledWith("完整文本");
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops tokens arriving after error (api-error is terminal)", async () => {
    const channels = captureChannel();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const finished = streamChat(buildPrompt("sys", "hi"), proxyModel, { onToken, onDone, onError });

    const channel = channels[0];
    channel.onmessage?.({ type: "error", message: "boom" });
    channel.onmessage?.({ type: "token", token: "b" });
    channel.onmessage?.({ type: "done" });

    await finished;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

// ── 代理不可用时错误透传（诊断体验）──
// proxyStreamChat 在 invoke 失败时此前只 console.warn 而不抛错,外层降级路径
// 只能上报泛化"LLM 请求失败";现在把具体原因随 outcome 一起透传出来。

describe("proxy unavailable error propagation", () => {
  it("surfaces the specific invoke error message for a remote model", async () => {
    // invoke 失败(模型不存在/配置缺失等)且模型为远程地址 → 降级路径上报具体原因
    vi.mocked(invoke).mockRejectedValue(new Error("model 'gpt-4o-mini' not found"));
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await streamChat(buildPrompt("sys", "hi"), proxyModel, { onToken, onDone, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toBe("model 'gpt-4o-mini' not found");
  });

  it("keeps the generic message when unavailable has no specific reason", async () => {
    // model.id 缺失 → 代理直接不可用且无具体错误 → 保持"LLM 请求失败"默认文案
    const noIdModel = { ...proxyModel, id: null as unknown as number };
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await streamChat(buildPrompt("sys", "hi"), noIdModel, { onToken, onDone, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toBe("LLM 请求失败");
  });
});

// ── B6：WebView 降级路径保留错误响应体 ──
// 代理不可用且为本地回环供应商时走 smartFetch 降级:非 2xx 必须带上游
// 响应体片段(与 Rust 侧 body_snippet、testLLMConnection 的策略对齐)

describe("WebView fallback error body (B6)", () => {
  const localModel = {
    id: 1,
    name: "test",
    api_key: "sk-test",
    base_url: "http://localhost:11434/v1",
    model_name: "llama3",
    is_default: true,
  } as unknown as ModelConfig;

  it("includes the upstream error body snippet in the failure message", async () => {
    // 代理不可用 → 本地模型降级 fetch → 上游 400 + 说明文本
    vi.mocked(invoke).mockRejectedValue(new Error("proxy unavailable in tests"));
    vi.mocked(smartFetch).mockResolvedValue(
      new Response("model 'llama3' not found", { status: 400, statusText: "Bad Request" }),
    );

    const onError = vi.fn();
    await streamChat(buildPrompt("sys", "hi"), localModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toContain("400");
    expect(err.message).toContain("Bad Request");
    expect(err.message).toContain("model 'llama3' not found");
  });

  it("truncates the error body to 200 characters", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("proxy unavailable in tests"));
    const longBody = "x".repeat(500);
    vi.mocked(smartFetch).mockResolvedValue(
      new Response(longBody, { status: 400, statusText: "Bad Request" }),
    );

    const onError = vi.fn();
    await streamChat(buildPrompt("sys", "hi"), localModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError,
    });

    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toContain("x".repeat(200));
    expect(err.message).not.toContain("x".repeat(201));
  });

  it("keeps the status-only message when the error body cannot be read", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("proxy unavailable in tests"));
    // body 读取失败（text() reject）时退化为纯状态码文案
    const brokenResponse = new Response(null, { status: 401, statusText: "Unauthorized" });
    vi.spyOn(brokenResponse, "text").mockRejectedValue(new Error("body consumed"));
    vi.mocked(smartFetch).mockResolvedValue(brokenResponse);

    const onError = vi.fn();
    await streamChat(buildPrompt("sys", "hi"), localModel, {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError,
    });

    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toBe("API 请求失败: 401 Unauthorized");
  });
});
