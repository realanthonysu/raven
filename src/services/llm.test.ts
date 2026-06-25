import { describe, expect, it, vi } from "vitest";
import { processSSELine, readSSEStream } from "./llm";

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
