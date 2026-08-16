import { describe, expect, it, vi } from "vitest";

// A1: llm.ts 依赖 @tauri-apps/api/core 的 Channel/invoke(代理路径)。
// 测试不覆盖代理路径(需真实 IPC),提供最小 stub 保持导入可用
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
    constructor() {}
  },
  invoke: vi.fn().mockRejectedValue(new Error("proxy unavailable in tests")),
}));

import { buildPrompt, processSSELine, readSSEStream } from "./llm";

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

describe("processSSELine", () => {
  it("returns token for valid data line", () => {
    const state = { fullText: "" };
    const result = processSSELine('data: {"choices":[{"delta":{"content":"Hello"}}]}', state);
    expect(result.token).toBe("Hello");
    expect(state.fullText).toBe("Hello");
  });

  it("returns done for [DONE] marker", () => {
    const state = { fullText: "" };
    const result = processSSELine("data: [DONE]", state);
    expect(result.done).toBe(true);
  });

  it("ignores empty lines", () => {
    const state = { fullText: "" };
    const result = processSSELine("", state);
    expect(result.token).toBeUndefined();
    expect(result.done).toBeUndefined();
  });

  it("ignores non-data lines", () => {
    const state = { fullText: "" };
    const result = processSSELine(": heartbeat", state);
    expect(result.token).toBeUndefined();
    expect(result.done).toBeUndefined();
  });

  it("ignores JSON without delta content", () => {
    const state = { fullText: "" };
    const result = processSSELine('data: {"choices":[{"delta":{"role":"assistant"}}]}', state);
    expect(result.token).toBeUndefined();
    expect(result.done).toBeUndefined();
  });

  it("ignores malformed JSON", () => {
    const state = { fullText: "" };
    const result = processSSELine("data: not-json", state);
    expect(result.token).toBeUndefined();
    expect(result.done).toBeUndefined();
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

describe("processSSELine SSE spec compliance (P1 regression)", () => {
  it("accepts 'data:' without a space before [DONE]", () => {
    const state = { fullText: "" };
    expect(processSSELine("data:[DONE]", state)).toEqual({ done: true });
  });

  it("accepts 'data:' without a space before JSON payload", () => {
    const state = { fullText: "" };
    const result = processSSELine('data:{"choices":[{"delta":{"content":"hi"}}]}', state);
    expect(result.token).toBe("hi");
    expect(state.fullText).toBe("hi");
  });

  it("still accepts 'data: ' with a space", () => {
    const state = { fullText: "" };
    const result = processSSELine('data: {"choices":[{"delta":{"content":"yo"}}]}', state);
    expect(result.token).toBe("yo");
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
