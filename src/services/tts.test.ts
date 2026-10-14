import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchTTSAudio 走 Rust 非流式代理（fetch_tts_audio），mock invoke 断言参数
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
import { fetchTTSAudio, saveTTSSettings, speakTestText, testTTSAudio } from "./tts";

const mockConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "test-key",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
  dialect: "mimo",
};

describe("fetchTTSAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes fetch_tts_audio with only text/speed/timeout (config is server-side)", async () => {
    const mockAudio = new ArrayBuffer(8);
    vi.mocked(invoke).mockResolvedValue(mockAudio);

    const result = await fetchTTSAudio("hello", mockConfig);

    // B-2: base_url/model/voice 不再经 IPC 传入，由代理命令服务端自读
    expect(invoke).toHaveBeenCalledWith("fetch_tts_audio", {
      text: "hello",
      speed: 1.0,
      timeoutMs: 60_000,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "fetch_tts_audio",
      expect.objectContaining({ baseUrl: "https://api.example.com/v1" }),
    );
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });

  it("passes custom timeout through to the proxy command", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await fetchTTSAudio("hello", mockConfig, undefined, 30_000);

    expect(invoke).toHaveBeenCalledWith(
      "fetch_tts_audio",
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

// ── testTTSAudio / speakTestText（B-2 试听路径：测试未保存的表单配置）──

describe("testTTSAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes test_tts_audio with unsaved config via the input struct", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(8));

    const result = await testTTSAudio("hello", mockConfig);

    expect(invoke).toHaveBeenCalledWith("test_tts_audio", {
      input: {
        base_url: "https://api.example.com/v1",
        api_key: "test-key",
        model: "tts-1",
        voice: "alloy",
        speed: 1.0,
        text: "hello",
      },
      timeoutMs: 60_000,
    });
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it("passes undefined api_key when the form key is untouched (server reads Keychain)", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await testTTSAudio("hi", { ...mockConfig, api_key: undefined });

    expect(invoke).toHaveBeenCalledWith(
      "test_tts_audio",
      expect.objectContaining({ input: expect.objectContaining({ api_key: undefined }) }),
    );
  });

  it("throws AbortError without invoking when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(testTTSAudio("hello", mockConfig, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("speakTestText", () => {
  /** stub Audio 让 playAudio 在 jsdom 中正常 resolve（onended 立即触发） */
  function stubAudioPlayback() {
    class FakeAudio {
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      currentTime = 0;
      set onended(handler: (() => void) | null) {
        handler?.();
      }
      set onerror(_handler: ((e?: unknown) => void) | null) {}
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // 复位 withTimeout 为默认非超时实现（前面的超时用例会覆盖为 isTimeout: true，
    // clearAllMocks 不清实现，需在此显式复位，否则拒绝路径会被误判为超时）
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => false,
      cleanup: vi.fn(),
    });
    stubAudioPlayback();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-synthesizes via test_tts_audio on every call (bypasses the audio cache)", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await speakTestText("hello", mockConfig);
    await speakTestText("hello", mockConfig);

    // 两次调用都发起了 IPC（每次重新合成）→ 证明试听不走 audioUrlCache 缓存
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith(
      "test_tts_audio",
      expect.objectContaining({ input: expect.objectContaining({ text: "hello" }) }),
    );
  });

  it("revokes the blob URL after playback", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));
    const revoke = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
    const create = URL.createObjectURL as ReturnType<typeof vi.fn>;

    await speakTestText("hi", mockConfig);

    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:mock");
  });

  it("rejects without creating a blob URL when the request fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("TTS 请求失败: 500"));
    const revoke = URL.revokeObjectURL as ReturnType<typeof vi.fn>;

    await expect(speakTestText("hi", mockConfig)).rejects.toThrow("TTS 请求失败: 500");
    expect(revoke).not.toHaveBeenCalled(); // 请求失败时尚未创建 blob URL
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
