import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchTTSAudio 走 Rust 非流式代理（fetch_tts_audio），mock invoke 断言参数
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// saveTTSSettings 委托 lib/db 的批量写入；speakText 自取配置并经版本戳键缓存
vi.mock("@/lib/db", () => ({
  setTTSSettingBatch: vi.fn(),
  getTTSConfigCached: vi.fn(),
  getTTSConfigVersion: vi.fn(() => 1),
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
import { getTTSConfigCached, getTTSConfigVersion, setTTSSettingBatch } from "@/lib/db";
import { withTimeout } from "@/lib/fetch-utils";
import {
  fetchTTSAudio,
  prefetchTTS,
  saveTTSSettings,
  speakTestText,
  speakText,
  TTS_NOT_CONFIGURED_MESSAGE,
  testTTSAudio,
} from "./tts";

const mockConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "test-key",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
  dialect: "mimo",
};

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

// ── saveTTSSettings（委托 lib/db 的批量写入）──
// 两级缓存失效均已结构化：配置缓存与版本戳自增在 lib/db setTTSSettingBatch 的
// finally 中完成；音频缓存经版本戳键结构性失效（不再依赖本函数手工清理）。
// 本用例组仅保证委托与错误传播。

describe("saveTTSSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the batch write to lib/db", async () => {
    vi.mocked(setTTSSettingBatch).mockResolvedValue(undefined);

    await saveTTSSettings([["tts_model", "tts-1"]]);

    expect(setTTSSettingBatch).toHaveBeenCalledWith([["tts_model", "tts-1"]]);
  });

  it("propagates write failures", async () => {
    vi.mocked(setTTSSettingBatch).mockRejectedValue(new Error("ipc fail"));

    await expect(saveTTSSettings([["tts_model", "x"]])).rejects.toThrow("ipc fail");
  });
});

// ── TTS_NOT_CONFIGURED_MESSAGE（未配置单源文案，对齐 LLM 侧单源模式）──

describe("TTS_NOT_CONFIGURED_MESSAGE", () => {
  it("keeps the canonical user-facing copy", () => {
    // 与 use-audio-player 的错误通道共享单源：文案变更须在此显式确认
    expect(TTS_NOT_CONFIGURED_MESSAGE).toBe("请先在设置中配置 TTS API Key 和 Base URL");
  });
});

// ── speakText（配置自取 + 校验 + 语速合成 + 版本戳缓存）──
// 注意：audioUrlCache 是模块级实例，跨用例存活（clearAllMocks 不清缓存）——
// 各用例使用互不相同的 text 避免缓存键碰撞导致断言失真。

describe("prefetchTTS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTTSConfigCached).mockResolvedValue(mockConfig);
    vi.mocked(getTTSConfigVersion).mockReturnValue(1);
    stubAudioPlayback();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms the audio cache so the subsequent speakText does not re-fetch", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await prefetchTTS("prefetch-warm");
    expect(invoke).toHaveBeenCalledWith("fetch_tts_audio", {
      text: "prefetch-warm",
      speed: 1.0,
      timeoutMs: 60_000,
    });

    await speakText("prefetch-warm");
    // 预取与播放共用 audioUrlCache 键 → 播放阶段不再发起 fetch_tts_audio
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns silently when TTS is not configured", async () => {
    vi.mocked(getTTSConfigCached).mockResolvedValue({ ...mockConfig, api_key: "", base_url: "" });

    await expect(prefetchTTS("prefetch-missing")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows fetch errors (best-effort prefetch)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("TTS 请求失败: 500"));

    await expect(prefetchTTS("prefetch-error")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("speakText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTTSConfigCached).mockResolvedValue(mockConfig);
    // clearAllMocks 不清实现：显式复位版本戳，防止前一个用例的 mockReturnValue 泄漏
    vi.mocked(getTTSConfigVersion).mockReturnValue(1);
    stubAudioPlayback();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the config itself and plays via the cached audio URL", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await speakText("hello-cfg");

    expect(getTTSConfigCached).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fetch_tts_audio", {
      text: "hello-cfg",
      speed: 1.0,
      timeoutMs: 60_000,
    });
  });

  it("throws TTS_NOT_CONFIGURED_MESSAGE without invoking when the config is incomplete", async () => {
    vi.mocked(getTTSConfigCached).mockResolvedValue({ ...mockConfig, api_key: "", base_url: "" });

    await expect(speakText("hello-missing")).rejects.toThrow(TTS_NOT_CONFIGURED_MESSAGE);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("composes the speed override over the configured default", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await speakText("hello-speed", { speed: 1.5 });

    expect(invoke).toHaveBeenCalledWith("fetch_tts_audio", expect.objectContaining({ speed: 1.5 }));
  });

  it("reuses the cached audio URL for identical text/speed within one config version", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await speakText("hello-cache", { speed: 1 });
    await speakText("hello-cache", { speed: 1 });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("misses stale cache entries after the config version advances (结构性失效)", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));

    await speakText("hello-version", { speed: 1 });
    // 配置变更 → lib/db 版本戳自增 → 旧版本条目不再命中（键含版本戳）
    vi.mocked(getTTSConfigVersion).mockReturnValue(2);
    await speakText("hello-version", { speed: 1 });

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects the aborted waiter with AbortError without starting playback", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(speakText("hello-abort", undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // 共享缓存 fetch 不绑定任何调用者的 signal（audioUrlCache 设计）：
    // raceWithAbort 仅在等待者侧桥接中止——已中止的等待者立刻被拒绝、
    // 不会进入 playAudio，但共享 fetch 本身照常发起（abort 仅放弃结果）。
    // flush 微任务让共享 fetch 链走完再断言
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});

// ── 音频缓存字节预算（S-14）──
// maxSize 只限制条目数；长文本音频（数百 KB/条）200 条可达数十 MB。
// 预算按音频原始字节累计，超限时 FIFO 淘汰最旧条目并 revoke 其 blob URL。
describe("audio cache byte budget (S-14)", () => {
  /** blob URL 为每个条目生成唯一值，便于断言"被淘汰的是哪一个" */
  function stubUniqueBlobUrls() {
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
    const created: string[] = [];
    const revoked: string[] = [];
    let seq = 0;
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        const url = `blob:tts-${++seq}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revoked.push(url);
      }),
    });
    return { created, revoked };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTTSConfigCached).mockResolvedValue(mockConfig);
    vi.mocked(getTTSConfigVersion).mockReturnValue(1);
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => false,
      cleanup: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revokes the oldest blob URL when the total audio bytes exceed the budget", async () => {
    const { created, revoked } = stubUniqueBlobUrls();
    // 每条 10MB：第 4 条入库后总字节 40MB > 32MB，FIFO 淘汰最早的条目
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(10 * 1024 * 1024));

    await speakText("budget-one");
    await speakText("budget-two");
    await speakText("budget-three");
    expect(revoked).toHaveLength(0);

    await speakText("budget-four");

    expect(created).toHaveLength(4);
    // 最早的 blob URL 被 revoke（释放内存），最新的（正被播放）必须保留
    expect(revoked).toContain(created[0]);
    expect(revoked).not.toContain(created[3]);
  });

  it("keeps identical text/speed hitting the cache after other entries are evicted", async () => {
    stubUniqueBlobUrls();
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(10 * 1024 * 1024));

    await speakText("budget-hit");
    await speakText("budget-other-1");
    await speakText("budget-other-2");

    // 仍在缓存预算内的条目继续命中，不重复请求
    await speakText("budget-other-2");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("exposes the byte budget as a documented constant", async () => {
    const { TTS_AUDIO_CACHE_MAX_BYTES } = await import("./tts");
    expect(TTS_AUDIO_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
