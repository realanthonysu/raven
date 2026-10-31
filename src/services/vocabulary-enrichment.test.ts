import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// enrichWord 的传输依赖（streamChatAsync/buildPrompt）与模型查询分别 mock；
// extractJsonSafe/Zod schema/createCachedFetcher/raceWithAbort 走真实实现，
// 使本套件端到端覆盖"LLM 文本 → 解析校验 → 缓存 → 调用者 abort 桥接"全链路
vi.mock("./llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChatAsync: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDefaultModelCached: vi.fn(),
}));

import { getDefaultModelCached } from "@/lib/db";
import { streamChatAsync } from "./llm";
import { enrichWord } from "./vocabulary-enrichment";

const mockStream = vi.mocked(streamChatAsync);
const mockGetModel = vi.mocked(getDefaultModelCached);

const MODEL = {
  id: 1,
  name: "test",
  api_key: "sk-test",
  base_url: "https://api.example.com/v1",
  model_name: "test-model",
  is_default: true,
};

/** 构造满足 EnrichedWordSchema 的 LLM JSON 输出 */
function enrichmentJson(word: string): string {
  return JSON.stringify({
    phonetic: `/${word}/`,
    definition: `释义：${word}`,
    collocations: `use ${word}`,
    example: `This is ${word}.`,
  });
}

describe("enrichWord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue(MODEL);
    // 失败路径会走 console.warn 静默降级日志，测试中静音
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed enrichment and builds dictionary prompt with the word", async () => {
    mockStream.mockResolvedValue(enrichmentJson("graceful"));

    const result = await enrichWord("graceful");

    expect(result).toEqual({
      phonetic: "/graceful/",
      definition: "释义：graceful",
      collocations: "use graceful",
      example: "This is graceful.",
    });
    expect(mockGetModel).toHaveBeenCalledTimes(1);
    const [messages] = mockStream.mock.calls[0];
    expect(messages[0]).toEqual({ role: "system", content: "你是一个英语词典助手。" });
    expect(messages[1].content).toContain("单词：graceful");
  });

  it("dedupes repeated lookups case-insensitively (lowercase cache key)", async () => {
    mockStream.mockResolvedValue(enrichmentJson("ephemeral"));

    await enrichWord("Ephemeral");
    await enrichWord("ephemeral");

    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("misses the old cache entry when the default model changes (model-aware key)", async () => {
    const MODEL_B = { ...MODEL, id: 2, name: "other", model_name: "other-model" };
    mockStream
      .mockResolvedValueOnce(enrichmentJson("serendipity"))
      .mockResolvedValueOnce(enrichmentJson("serendipity"));

    mockGetModel.mockResolvedValue(MODEL);
    await enrichWord("Serendipity");
    expect(mockStream).toHaveBeenCalledTimes(1);

    // 用户切换默认模型（不同 id）后：同词必须重新请求，不得复用旧模型的缓存补全
    mockGetModel.mockResolvedValue(MODEL_B);
    const result = await enrichWord("serendipity");

    expect(result).toEqual({
      phonetic: "/serendipity/",
      definition: "释义：serendipity",
      collocations: "use serendipity",
      example: "This is serendipity.",
    });
    // 第二次调用走的是新模型的传输请求（缓存键含模型 id，旧条目自然失配）
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1][1]).toBe(MODEL_B);
  });

  it("returns null on transport failure but does not cache the failure (retry works)", async () => {
    mockStream
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(enrichmentJson("resilience"));

    await expect(enrichWord("resilience")).resolves.toBeNull();
    // rejection 路径已移除缓存条目 → 同一单词再次调用应重新请求并成功
    await expect(enrichWord("resilience")).resolves.toEqual({
      phonetic: "/resilience/",
      definition: "释义：resilience",
      collocations: "use resilience",
      example: "This is resilience.",
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("returns null when no default model is configured (transport untouched)", async () => {
    mockGetModel.mockResolvedValue(null);

    await expect(enrichWord("orphan")).resolves.toBeNull();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("returns null when LLM output fails schema validation (parse failed)", async () => {
    mockStream.mockResolvedValue("not json at all");

    await expect(enrichWord("garbled")).resolves.toBeNull();
  });

  it("aborted waiter gets null without poisoning the shared cached request", async () => {
    mockStream.mockResolvedValue(enrichmentJson("shared"));
    const controller = new AbortController();
    controller.abort();

    // 已中止的等待者立即以 AbortError 拒绝 → 包装为 null；
    // 缓存的共享 Promise 不受影响（cached(word) 在 raceWithAbort 前求值）
    await expect(enrichWord("shared", controller.signal)).resolves.toBeNull();

    // 另一个未中止的调用者共享同一请求，正常拿到结果（不重复发起传输）
    await expect(enrichWord("shared")).resolves.toEqual({
      phonetic: "/shared/",
      definition: "释义：shared",
      collocations: "use shared",
      example: "This is shared.",
    });
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("forwards the batch signal to streamChatAsync and cancels the underlying request", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStream.mockImplementation(
      (_messages, _model, signal) =>
        new Promise<string>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const controller = new AbortController();
    const pending = enrichWord("cancelled-word", controller.signal);
    await vi.waitFor(() => expect(capturedSignal).toBe(controller.signal));

    controller.abort();
    await expect(pending).resolves.toBeNull();

    // abort 后缓存条目已随 rejection 移除；后续无 signal 的调用会重新请求并成功
    mockStream.mockResolvedValue(enrichmentJson("cancelled-word"));
    await expect(enrichWord("cancelled-word")).resolves.toEqual({
      phonetic: "/cancelled-word/",
      definition: "释义：cancelled-word",
      collocations: "use cancelled-word",
      example: "This is cancelled-word.",
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
  });
});
