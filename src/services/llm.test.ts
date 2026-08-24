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
// 测试不触达该路径,mock 仅保持导入可用
vi.mock("@/lib/fetch-utils", () => ({
  smartFetch: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { ModelConfig } from "@/types";
import { buildPrompt, isLocalBaseUrl, readSSEStream, streamChat, testLLMConnection } from "./llm";

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
  it("invokes test_llm_connection with baseUrl/apiKey/modelName", async () => {
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
    | ((event: {
        type: "token" | "done" | "error";
        token?: string;
        fullText?: string;
        message?: string;
      }) => void)
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
    vi.mocked(invoke).mockImplementation(async (_cmd: unknown, args: unknown) => {
      channels.push((args as { onEvent: CapturedChannel }).onEvent);
      return null;
    });
    return channels;
  }

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
    channel.onmessage?.({ type: "done", fullText: "ab" });
    channel.onmessage?.({ type: "error", message: "late error" });

    await finished;

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("a");
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops tokens arriving after done", async () => {
    const channels = captureChannel();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const finished = streamChat(buildPrompt("sys", "hi"), proxyModel, { onToken, onDone, onError });

    const channel = channels[0];
    channel.onmessage?.({ type: "token", token: "a" });
    channel.onmessage?.({ type: "done", fullText: "a" });
    channel.onmessage?.({ type: "token", token: "b" });

    await finished;

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("a");
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
    channel.onmessage?.({ type: "done", fullText: "b" });

    await finished;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
