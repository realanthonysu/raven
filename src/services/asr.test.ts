import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 数据库层（asr.ts 仅使用 getASRModel / getTTSConfigCached）
vi.mock("@/lib/db", () => ({
  getASRModel: vi.fn(),
  getTTSConfigCached: vi.fn(),
}));

// 转写走 Rust 非流式代理（transcribe_audio），mock invoke 断言参数
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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
import { getASRModel, getTTSConfigCached } from "@/lib/db";
import { withTimeout } from "@/lib/fetch-utils";
import { convertToWav, transcribeAudio } from "./asr";

// ─── convertToWav / WAV 编码 ────────────────────────────────────────

/** 构造假 AudioBuffer（jsdom 无 Web Audio API） */
function makeFakeAudioBuffer(samples: number[], sampleRate = 8000) {
  const data = new Float32Array(samples);
  return {
    sampleRate,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: (channel: number) => {
      if (channel !== 0) throw new Error("only channel 0 exists");
      return data;
    },
  } as unknown as AudioBuffer;
}

/** 读取 DataView 中的 ASCII 字符串 */
function readString(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

describe("convertToWav", () => {
  const decodeAudioData = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    close.mockResolvedValue(undefined);
    // stub AudioContext：decodeAudioData 返回假 AudioBuffer（需可 new 构造，故用 class）
    class FakeAudioContext {
      decodeAudioData = decodeAudioData;
      close = close;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces a valid 44-byte WAV header (16-bit PCM mono)", async () => {
    const sampleRate = 16000;
    decodeAudioData.mockResolvedValue(makeFakeAudioBuffer([0, 0.5, -0.5], sampleRate));

    const wav = await convertToWav(new Blob([new Uint8Array([1, 2, 3])]));
    expect(wav.type).toBe("audio/wav");

    const view = new DataView(await wav.arrayBuffer());
    const dataLength = 3 * 2; // 3 个样本 × 16-bit
    expect(wav.size).toBe(44 + dataLength);

    expect(readString(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(44 + dataLength - 8);
    expect(readString(view, 8, 4)).toBe("WAVE");
    expect(readString(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bitDepth
    expect(readString(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(dataLength);
  });

  it("encodes samples as Int16 with asymmetric scaling", async () => {
    decodeAudioData.mockResolvedValue(makeFakeAudioBuffer([0, 1, -1, 0.5, -0.5]));

    const wav = await convertToWav(new Blob([]));
    const view = new DataView(await wav.arrayBuffer());

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff); // 1 → 32767
    expect(view.getInt16(48, true)).toBe(-0x8000); // -1 → -32768
    expect(view.getInt16(50, true)).toBe(Math.trunc(0.5 * 0x7fff)); // 16383
    expect(view.getInt16(52, true)).toBe(-0.5 * 0x8000); // -16384
  });

  it("clamps out-of-range samples to [-1, 1]", async () => {
    decodeAudioData.mockResolvedValue(makeFakeAudioBuffer([2, -2]));

    const wav = await convertToWav(new Blob([]));
    const view = new DataView(await wav.arrayBuffer());

    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it("closes the AudioContext even when decoding fails", async () => {
    decodeAudioData.mockRejectedValue(new Error("decode failed"));

    await expect(convertToWav(new Blob([]))).rejects.toThrow("decode failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ─── transcribeAudio ────────────────────────────────────────────────

const mockConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "test-key",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
};

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTTSConfigCached).mockResolvedValue(mockConfig);
    vi.mocked(getASRModel).mockResolvedValue("mimo-v2.5-asr");
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => false,
      cleanup: vi.fn(),
    });
  });

  it("invokes transcribe_audio with config/model/language and data URL audio", async () => {
    vi.mocked(invoke).mockResolvedValue("hello world");

    const result = await transcribeAudio(new Blob(["abc"], { type: "audio/wav" }), "en");
    expect(result).toBe("hello world");

    expect(invoke).toHaveBeenCalledWith("transcribe_audio", {
      baseUrl: "https://api.example.com/v1",
      model: "mimo-v2.5-asr",
      language: "en",
      audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      timeoutMs: 60_000,
    });
  });

  it("passes base_url through unchanged (endpoint normalization is Rust-side)", async () => {
    vi.mocked(getTTSConfigCached).mockResolvedValue({
      ...mockConfig,
      base_url: "https://api.example.com/v1/chat/completions",
    });
    vi.mocked(invoke).mockResolvedValue("ok");

    await transcribeAudio(new Blob([]));

    expect(invoke).toHaveBeenCalledWith(
      "transcribe_audio",
      expect.objectContaining({ baseUrl: "https://api.example.com/v1/chat/completions" }),
    );
  });

  it("uses modelOverride when provided", async () => {
    vi.mocked(invoke).mockResolvedValue("ok");

    await transcribeAudio(new Blob([]), "en", "custom-asr");

    expect(getASRModel).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      "transcribe_audio",
      expect.objectContaining({ model: "custom-asr" }),
    );
  });

  it("strips <think> and <chinese> blocks from the transcript", async () => {
    vi.mocked(invoke).mockResolvedValue(
      "<think>reasoning...</think>Hello there<chinese>你好</chinese>",
    );

    await expect(transcribeAudio(new Blob([]))).resolves.toBe("Hello there");
  });

  it("strips unclosed <think> block to the end", async () => {
    vi.mocked(invoke).mockResolvedValue("Good morning<think>dangling");

    await expect(transcribeAudio(new Blob([]))).resolves.toBe("Good morning");
  });

  it("throws timeout error when the request aborts due to timeout", async () => {
    const cleanup = vi.fn();
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => true,
      cleanup,
    });
    vi.mocked(invoke).mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(transcribeAudio(new Blob([]))).rejects.toThrow("语音识别请求超时（60秒）");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-timeout proxy errors", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("network down"));

    await expect(transcribeAudio(new Blob([]))).rejects.toThrow("network down");
  });

  it("propagates upstream non-ok error surfaced by the proxy", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("语音识别服务请求失败 (500)"));

    await expect(transcribeAudio(new Blob([]))).rejects.toThrow("语音识别服务请求失败 (500)");
  });

  it("propagates invalid-shape error surfaced by the proxy", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ASR 响应格式无效，无法解析转写文本"));

    await expect(transcribeAudio(new Blob([]))).rejects.toThrow(
      "ASR 响应格式无效，无法解析转写文本",
    );
  });

  it("throws AbortError without invoking when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribeAudio(new Blob([]), "en", undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
