import { beforeEach, describe, expect, it, vi } from "vitest";

// fetchTTSAudio 走 Rust 非流式代理（db_fetch_tts_audio），mock invoke 断言参数
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// saveTTSSettings 委托 lib/db 的批量写入
vi.mock("@/lib/db", () => ({
  setTTSSettingBatch: vi.fn(),
}));

// 仅 mock withTimeout（默认非超时；超时用例中覆盖为 isTimeout: true）
vi.mock("@/lib/fetch-utils", () => ({
  withTimeout: vi.fn(() => ({
    signal: new AbortController().signal,
    isTimeout: () => false,
    cleanup: vi.fn(),
  })),
}));

import { invoke } from "@tauri-apps/api/core";
import { setTTSSettingBatch } from "@/lib/db";
import { withTimeout } from "@/lib/fetch-utils";
import { fetchTTSAudio, saveTTSSettings } from "./tts";

const mockConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "test-key",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
};

describe("fetchTTSAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes db_fetch_tts_audio with config fields and default timeout", async () => {
    const mockAudio = new ArrayBuffer(8);
    vi.mocked(invoke).mockResolvedValue(mockAudio);

    const result = await fetchTTSAudio("hello", mockConfig);

    expect(invoke).toHaveBeenCalledWith("db_fetch_tts_audio", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "tts-1",
      voice: "alloy",
      speed: 1.0,
      text: "hello",
      timeoutMs: 60_000,
    });
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });

  it("passes custom timeout through to the proxy command", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await fetchTTSAudio("hello", mockConfig, undefined, 30_000);

    expect(invoke).toHaveBeenCalledWith(
      "db_fetch_tts_audio",
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("propagates proxy errors (upstream non-ok surfaces as rejected invoke)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("TTS 请求失败: 500 Internal Server Error"));

    await expect(fetchTTSAudio("hello", mockConfig)).rejects.toThrow("TTS 请求失败: 500");
  });

  it("throws timeout error when the merged timeout signal fires", async () => {
    const cleanup = vi.fn();
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => true,
      cleanup,
    });
    vi.mocked(invoke).mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(fetchTTSAudio("hello", mockConfig)).rejects.toThrow("TTS 请求超时（60秒）");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("throws AbortError without invoking when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(fetchTTSAudio("hello", mockConfig, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── saveTTSSettings（S4：写入与音频缓存失效的编排上移到服务层）──
// 音频缓存的失效发生在 finally 中（写失败也要失效，防止旧供应商音频继续命中），
// 该语义由本用例组保证委托与错误传播，缓存行为由 invalidateTTSAudioCache 的
// 模块内单一路径保证。

describe("saveTTSSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the batch write to lib/db", async () => {
    vi.mocked(setTTSSettingBatch).mockResolvedValue(undefined);

    await saveTTSSettings([["tts_model", "tts-1"]]);

    expect(setTTSSettingBatch).toHaveBeenCalledWith([["tts_model", "tts-1"]]);
  });

  it("propagates write failures (finally 仍会执行缓存失效)", async () => {
    vi.mocked(setTTSSettingBatch).mockRejectedValue(new Error("ipc fail"));

    await expect(saveTTSSettings([["tts_model", "x"]])).rejects.toThrow("ipc fail");
  });
});
