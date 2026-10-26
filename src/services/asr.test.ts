import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 数据库层（asr.ts 仅使用 getASRModel；B-2 后不再读取 TTS 配置）
vi.mock("@/lib/db", () => ({
  getASRModel: vi.fn(),
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
import { getASRModel } from "@/lib/db";
import { withTimeout } from "@/lib/fetch-utils";
import { convertToWav, transcribeAudio, transcribeRecording } from "./asr";

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

/** 构造假多声道 AudioBuffer（channels[0] 为左声道，其余依次） */
function makeFakeMultiChannelBuffer(channels: number[][], sampleRate = 8000) {
  const data = channels.map((samples) => new Float32Array(samples));
  return {
    sampleRate,
    length: data[0].length,
    numberOfChannels: data.length,
    getChannelData: (channel: number) => {
      const channelData = data[channel];
      if (!channelData) throw new Error(`channel ${channel} does not exist`);
      return channelData;
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

  it("mixes stereo channels down to mono (right channel is not dropped)", async () => {
    // 立体声录音此前只取 channel 0，右声道内容整体丢失；
    // 现在按样本位置取各声道平均值后再编码
    decodeAudioData.mockResolvedValue(
      makeFakeMultiChannelBuffer([
        [1, 0.5, -1], // 左声道
        [0, 0.5, -0.5], // 右声道
      ]),
    );

    const wav = await convertToWav(new Blob([]));
    const view = new DataView(await wav.arrayBuffer());

    // 输出仍是单声道 WAV，数据长度为 3 个样本
    expect(view.getUint16(22, true)).toBe(1);
    expect(wav.size).toBe(44 + 3 * 2);

    expect(view.getInt16(44, true)).toBe(Math.trunc(0.5 * 0x7fff)); // (1+0)/2
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff)); // (0.5+0.5)/2
    expect(view.getInt16(48, true)).toBe(-0.75 * 0x8000); // (-1 + -0.5)/2
  });

  it("averages more than two channels when mixing down", async () => {
    decodeAudioData.mockResolvedValue(makeFakeMultiChannelBuffer([[0.9], [0.3], [0.6]]));

    const wav = await convertToWav(new Blob([]));
    const view = new DataView(await wav.arrayBuffer());

    // (0.9 + 0.3 + 0.6) / 3 = 0.6
    expect(view.getInt16(44, true)).toBe(Math.trunc(0.6 * 0x7fff));
  });

  it("closes the AudioContext even when decoding fails", async () => {
    decodeAudioData.mockRejectedValue(new Error("decode failed"));

    await expect(convertToWav(new Blob([]))).rejects.toThrow("decode failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ─── transcribeAudio ────────────────────────────────────────────────

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getASRModel).mockResolvedValue("mimo-v2.5-asr");
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => false,
      cleanup: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes transcribe_audio with model/language and data URL audio (no base_url)", async () => {
    vi.mocked(invoke).mockResolvedValue("hello world");

    const result = await transcribeAudio(new Blob(["abc"], { type: "audio/wav" }), "en");
    expect(result).toBe("hello world");

    // B-2: base_url 不再经 IPC 传入，由代理命令服务端自读
    expect(invoke).toHaveBeenCalledWith("transcribe_audio", {
      model: "mimo-v2.5-asr",
      language: "en",
      audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      timeoutMs: 60_000,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "transcribe_audio",
      expect.objectContaining({ baseUrl: expect.any(String) }),
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

  it("rejects with a descriptive Error when reading the audio blob fails", async () => {
    // jsdom 的 FileReader 不易触发 onerror，用 stub 模拟读取失败：
    // 旧实现把 ProgressEvent 直接 reject，错误信息会退化成"未知错误"
    class FailingFileReader {
      onloadend: (() => void) | null = null;
      onerror: ((event: ProgressEvent) => void) | null = null;
      readAsDataURL() {
        this.onerror?.({ type: "error" } as ProgressEvent);
      }
    }
    vi.stubGlobal("FileReader", FailingFileReader);

    await expect(transcribeAudio(new Blob(["abc"], { type: "audio/wav" }), "en")).rejects.toThrow(
      "读取音频数据失败",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ─── transcribeRecording（stop → WAV → ASR 单源管线）────────────────
// 走真实的 convertToWav / transcribeAudio（仅 stub 既有 mock 边界：
// invoke、getASRModel、AudioContext），验证管线编排本身。

describe("transcribeRecording", () => {
  const decodeAudioData = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    close.mockResolvedValue(undefined);
    vi.mocked(getASRModel).mockResolvedValue("mimo-v2.5-asr");
    vi.mocked(withTimeout).mockReturnValue({
      signal: new AbortController().signal,
      isTimeout: () => false,
      cleanup: vi.fn(),
    });
    class FakeAudioContext {
      decodeAudioData = decodeAudioData;
      close = close;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    decodeAudioData.mockResolvedValue(makeFakeAudioBuffer([0, 0.5, -0.5]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects empty/null-ish recordings without touching the pipeline", async () => {
    await expect(transcribeRecording(new Blob([]))).rejects.toThrow("录音为空");
    // 零大小检查先于解码：AudioContext 不应被构造
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("runs the full pipeline: WAV conversion then transcription", async () => {
    vi.mocked(invoke).mockResolvedValue("hello world");

    const result = await transcribeRecording(new Blob(["fake-webm"], { type: "audio/webm" }));

    expect(result).toBe("hello world");
    // WAV 转换真实发生（解码被调用），转写收到 data:audio/wav 的 data URL
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "transcribe_audio",
      expect.objectContaining({
        model: "mimo-v2.5-asr",
        language: "en",
        audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      }),
    );
  });

  it("forwards modelOverride to the transcription (VoiceCard 试听未保存模型)", async () => {
    vi.mocked(invoke).mockResolvedValue("ok");

    await transcribeRecording(new Blob(["fake"]), { modelOverride: "custom-asr" });

    expect(getASRModel).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      "transcribe_audio",
      expect.objectContaining({ model: "custom-asr" }),
    );
  });

  it("rejects with AbortError without invoking when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    // WAV 转换仍会执行（管线第一段无 signal 参与），中止在转写请求前被预检拦截
    await expect(
      transcribeRecording(new Blob(["fake"]), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
