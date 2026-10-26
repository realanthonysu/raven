/**
 * useAudioPlayer hook tests.
 *
 * 覆盖全局互斥播放（P1 回归）：多个实例（同屏多个 SpeakButton）
 * 同一时刻只允许一路音频，新播放开始前停止其他实例；
 * 以及错误通道：speakText 抛出的规范文案（TTS_NOT_CONFIGURED_MESSAGE）
 * 经 onError 原样上报。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSpeakText = vi.fn();

vi.mock("@/services/tts", () => ({
  // 常量值与 services/tts 的真实值逐字一致（真实值由 tts.test.ts 钉住）；
  // 本文件只验证 hook 把 speakText 抛出的错误经 onError 原样转发
  TTS_NOT_CONFIGURED_MESSAGE: "请先在设置中配置 TTS API Key 和 Base URL",
  speakText: (...args: unknown[]) => mockSpeakText(...args),
}));

import { TTS_NOT_CONFIGURED_MESSAGE } from "@/services/tts";
import { useAudioPlayer } from "./use-audio-player";

/** 构造随 signal 中止的 speakText mock：返回可手动 resolve 的受控 Promise */
function makeControllableSpeak() {
  const pending: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
  }> = [];
  mockSpeakText.mockImplementation(
    (_text: string, _opts: unknown, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject, signal };
        pending.push(entry);
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
  return pending;
}

describe("useAudioPlayer global mutual exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starting a second instance stops the first playback", async () => {
    const pending = makeControllableSpeak();

    // 同一组件内两个 useAudioPlayer 实例（模拟同屏两个 SpeakButton）
    const { result } = renderHook(() => ({
      a: useAudioPlayer(),
      b: useAudioPlayer(),
    }));

    // 实例 A 开始播放（挂起）
    let aPlay: Promise<boolean> | null = null;
    act(() => {
      aPlay = result.current.a.play("first");
    });
    await waitFor(() => expect(mockSpeakText).toHaveBeenCalledTimes(1));
    expect(result.current.a.playing).toBe(true);

    // 实例 B 开始播放 → A 应被全局互斥停止
    act(() => {
      result.current.b.play("second");
    });
    await waitFor(() => expect(mockSpeakText).toHaveBeenCalledTimes(2));

    // A 的 play 因中止返回 false，playing 归位
    await expect(aPlay).resolves.toBe(false);
    await waitFor(() => expect(result.current.a.playing).toBe(false));
    expect(result.current.b.playing).toBe(true);

    // B 正常播完
    await act(async () => {
      pending[1].resolve();
    });
    await waitFor(() => expect(result.current.b.playing).toBe(false));
  });

  it("same instance replay does not self-terminate via the registry", async () => {
    const pending = makeControllableSpeak();

    const { result } = renderHook(() => ({ a: useAudioPlayer() }));

    act(() => {
      result.current.a.play("first");
    });
    await waitFor(() => expect(mockSpeakText).toHaveBeenCalledTimes(1));

    // 同实例重新播放：第一次被 abort（既有语义），第二次正常进行
    act(() => {
      result.current.a.play("second");
    });
    await waitFor(() => expect(mockSpeakText).toHaveBeenCalledTimes(2));
    expect(result.current.a.playing).toBe(true);

    await act(async () => {
      pending[1].resolve();
    });
    await waitFor(() => expect(result.current.a.playing).toBe(false));
  });

  it("surfaces the not-configured TTS error via onError with the canonical message", async () => {
    // speakText（services/tts）在配置缺失时抛 TTS_NOT_CONFIGURED_MESSAGE；
    // hook 的职责是把该错误经既有 onError 通道原样上报并复位状态
    mockSpeakText.mockRejectedValue(new Error(TTS_NOT_CONFIGURED_MESSAGE));
    const onError = vi.fn();
    const { result } = renderHook(() => useAudioPlayer({ onError }));

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.play("hello");
    });

    expect(outcome).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(TTS_NOT_CONFIGURED_MESSAGE);
    expect(result.current.playing).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});
