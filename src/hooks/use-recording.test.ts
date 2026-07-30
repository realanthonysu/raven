import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模拟 MediaRecorder —— 追踪 onstop 回调以便测试中手动触发
let recorderOnStopCallback: (() => void) | null = null;

const mockGetTracks = vi.fn().mockReturnValue([{ stop: vi.fn() }]);

vi.stubGlobal(
  "MediaRecorder",
  class MockMediaRecorder {
    state: string;
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor() {
      this.state = "recording";

      const origOnStop = Object.getOwnPropertyDescriptor(this, "onstop");
      Object.defineProperty(this, "onstop", {
        get: () => origOnStop?.get?.call(this),
        set: (fn) => {
          origOnStop?.set?.call(this, fn);
          recorderOnStopCallback = fn;
        },
        configurable: true,
      });
    }

    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      // 不自动触发 onstop —— 由测试控制时机
    }
    static isTypeSupported = vi.fn().mockReturnValue(true);
  },
);

vi.stubGlobal("navigator", {
  mediaDevices: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: mockGetTracks }),
  },
});

import { useRecording } from "./use-recording";

describe("useRecording", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recorderOnStopCallback = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-stop assembles chunks into blob; stop() returns it instead of null", async () => {
    const { result } = renderHook(() => useRecording({ maxDurationMs: 5000 }));

    // 开始录音
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.recording).toBe(true);

    // 模拟 MediaRecorder 触发数据事件（录音数据）
    // 注：mock MediaRecorder 构造函数中 ondataavailable 设置较复杂，
    // 实际的 chunksRef 在真实浏览器中由 ondataavailable 填充。
    // 这里我们直接验证 auto-stop 流程中 blob 被保存。

    // 快进到 auto-stop 触发
    act(() => {
      vi.advanceTimersByTime(5100);
    });

    // auto-stop 调用了 recorder.stop()，但 onstop 还未触发。
    // 模拟 onstop 触发（真实的 MediaRecorder 在 stop 后异步触发）
    act(() => {
      recorderOnStopCallback?.();
    });

    // auto-stop 后 recording 应为 false
    expect(result.current.recording).toBe(false);

    // 核心测试：stop() 应返回 auto-stop 保存的 blob（而非 null）
    const blob = await act(async () => result.current.stop());
    expect(blob).not.toBeNull();
    expect(blob).toBeInstanceOf(Blob);
  });

  it("stop() returns null after auto-stop blob was already consumed", async () => {
    const { result } = renderHook(() => useRecording({ maxDurationMs: 5000 }));

    await act(async () => {
      await result.current.start();
    });

    // 触发 auto-stop
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    act(() => {
      recorderOnStopCallback?.();
    });

    // 第一次 stop() 拿到 blob
    const blob1 = await act(async () => result.current.stop());
    expect(blob1).not.toBeNull();

    // 第二次 stop() 返回 null（已消费）
    const blob2 = await act(async () => result.current.stop());
    expect(blob2).toBeNull();
  });
});
