/**
 * useSpeakingSession hook tests.
 *
 * 重构核心验证：录音 → WAV 转换 → ASR 转写 → LLM 评估 的单句媒体管线
 * 必须能在 hook 层面独立驱动（无需挂载 SpeakingPage）。
 *
 * mock 策略（沿用 use-audio-player.test.ts 的委托包装惯用法，规避 vi.mock
 * 工厂提升导致的 TDZ 问题）：
 * - @/hooks/use-recording：可控的 start/stop
 * - @/services/asr：可控的 convertToWav / transcribeAudio（捕获 AbortSignal）
 * - @/hooks/use-stream-chat：捕获 execute 的 overrides，由测试手动触发 onDone/onError
 *
 * reducer 使用真实实现 —— 同时覆盖 hook 与 speakingReducer 的集成。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeakingScore, SpeakingSentence } from "@/types";
import { initialSpeakingState, speakingReducer } from "../speaking-reducer";
import { useSpeakingSession } from "./use-speaking-session";

// ─── Mock state ───────────────────────────────────────────────────

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockUseRecording = vi.fn();

vi.mock("@/hooks/use-recording", () => ({
  useRecording: (...args: unknown[]) => mockUseRecording(...args),
}));

const mockConvertToWav = vi.fn();
const mockTranscribeAudio = vi.fn();

vi.mock("@/services/asr", () => ({
  convertToWav: (...args: unknown[]) => mockConvertToWav(...args),
  transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
}));

/** execute 最近一次调用的 overrides，供测试手动触发 onDone / onError / onAbort 回调 */
let capturedEvaluation: {
  prompt: string;
  userContent: string;
  overrides?: {
    onDone?: (fullText: string) => void;
    onError?: (error: Error) => void;
    onAbort?: () => void;
  };
} | null = null;

const mockExecuteEvaluation = vi.fn();
const mockAbortEvaluation = vi.fn();
const mockUseStreamChat = vi.fn();

vi.mock("@/hooks/use-stream-chat", () => ({
  useStreamChat: (...args: unknown[]) => mockUseStreamChat(...args),
}));

// ─── Test fixtures ────────────────────────────────────────────────

const sentences: SpeakingSentence[] = [
  { text: "Hello world", translation: "你好世界" },
  { text: "Good morning", translation: "早上好" },
];

const scoreJson = (overall: number): string =>
  JSON.stringify({
    pronunciation: overall,
    grammar: overall,
    fluency: overall,
    overall,
    feedback: "发音不错",
  } satisfies SpeakingScore);

// ─── Harness ──────────────────────────────────────────────────────

/**
 * 渲染 useSpeakingSession + 真实 speakingReducer：
 * 返回值同时暴露会话控制接口与 reducer 状态，供断言结果写回。
 *
 * currentIndex 经 initialProps 注入（renderHook 的 rerender 可改），
 * 支撑"录音期间切句"的索引锁定用例。
 *
 * 初始状态经 INIT 派生（与真实页面生成完成后的状态一致：results 按
 * 句数填满 null），而非空数组 —— 保证 replaceAt 写入后其余槽位为 null。
 */
function renderSessionHarness(currentIndex = 0) {
  return renderHook(
    ({ index }: { index: number }) => {
      const [state, dispatch] = useReducer(speakingReducer, initialSpeakingState, (init) =>
        speakingReducer(init, { type: "INIT", sentences }),
      );
      const session = useSpeakingSession({ sentences, currentIndex: index, dispatch });
      return { session, state };
    },
    { initialProps: { index: currentIndex } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedEvaluation = null;

  mockStart.mockResolvedValue(undefined);
  mockStop.mockResolvedValue(new Blob(["fake-audio"], { type: "audio/webm" }));
  mockConvertToWav.mockResolvedValue(new Blob(["fake-wav"], { type: "audio/wav" }));
  mockTranscribeAudio.mockResolvedValue("hello world");
  mockUseRecording.mockReturnValue({
    recording: false,
    loading: false,
    error: null,
    start: mockStart,
    stop: mockStop,
  });

  // 默认实现：记录调用参数并立即触发 onDone（模拟流式完成）
  mockExecuteEvaluation.mockImplementation(
    (prompt: string, userContent: string, overrides?: { onDone?: (fullText: string) => void }) => {
      capturedEvaluation = { prompt, userContent, overrides };
      overrides?.onDone?.(scoreJson(90));
      return Promise.resolve();
    },
  );
  mockAbortEvaluation.mockImplementation(() => {});
  mockUseStreamChat.mockReturnValue({
    loading: false,
    error: null,
    setError: vi.fn(),
    execute: mockExecuteEvaluation,
    abort: mockAbortEvaluation,
  });
});

// ─── Tests ────────────────────────────────────────────────────────

describe("useSpeakingSession", () => {
  it("drives one full record→stop→transcribe→evaluate cycle and writes the result into the reducer", async () => {
    const { result } = renderSessionHarness(0);

    // 开始录音
    await act(async () => {
      await result.current.session.startRecording();
    });
    expect(mockStart).toHaveBeenCalledTimes(1);

    // 停止录音 → 全流程完成
    await act(async () => {
      await result.current.session.stopRecording();
    });

    // WAV 转换收到原始录音 Blob；ASR 收到 wav、语言 "en"、AbortSignal 实例
    expect(mockConvertToWav).toHaveBeenCalledTimes(1);
    expect(mockConvertToWav.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    const [, language, modelOverride, signal] = mockTranscribeAudio.mock.calls[0];
    expect(language).toBe("en");
    expect(modelOverride).toBeUndefined();
    expect(signal).toBeInstanceOf(AbortSignal);

    // 评估走专属 useStreamChat("speaking") 通道：EVALUATION_PROMPT(原句, 转写) + 空 user 内容
    expect(mockExecuteEvaluation).toHaveBeenCalledTimes(1);
    expect(capturedEvaluation?.userContent).toBe("");
    expect(capturedEvaluation?.prompt).toContain("Hello world");
    expect(capturedEvaluation?.prompt).toContain("hello world");

    // 结果写回 index 锁定的目标句，busy 标志复位，无错误残留
    expect(result.current.session.recognizing).toBe(false);
    expect(result.current.session.evaluating).toBe(false);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.currentTranscription).toBe("hello world");
    expect(result.current.state.results[0]).toEqual({
      transcription: "hello world",
      score: expect.objectContaining({ overall: 90 }),
    });
    expect(result.current.state.results[1]).toBeNull();
  });

  it("ignores stopRecording re-entry while the pipeline is processing", async () => {
    // convertToWav 挂起，制造「识别中」窗口
    let resolveWav!: (blob: Blob) => void;
    mockConvertToWav.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          resolveWav = resolve;
        }),
    );

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });

    let firstStop: Promise<void> | null = null;
    act(() => {
      firstStop = result.current.session.stopRecording();
    });
    await waitFor(() => expect(result.current.session.recognizing).toBe(true));

    // 处理中的第二次 stopRecording 必须被守卫忽略：不再取录音数据、不再触发转换
    await act(async () => {
      await result.current.session.stopRecording();
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockConvertToWav).toHaveBeenCalledTimes(1);
    expect(mockTranscribeAudio).not.toHaveBeenCalled();

    // 放行首次管线，正常走完
    await act(async () => {
      resolveWav(new Blob(["wav"], { type: "audio/wav" }));
      await firstStop;
    });
    expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    expect(result.current.state.results[0]).not.toBeNull();
  });

  it("aborts the in-flight ASR request on unmount", async () => {
    // transcribeAudio 挂起并捕获外部传入的 AbortSignal
    const signals: AbortSignal[] = [];
    mockTranscribeAudio.mockImplementation(
      (_blob: Blob, _lang: string, _model: unknown, signal?: AbortSignal) =>
        new Promise<string>(() => {
          signals.push(signal as AbortSignal);
        }),
    );

    const { result, unmount } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });
    // 不在 act 内 await stopRecording —— transcribeAudio 永久挂起会让 act 卡死；
    // 触发后轮询等待转写调用发生
    let stopPromise: Promise<void> | null = null;
    act(() => {
      stopPromise = result.current.session.stopRecording();
    });
    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0].aborted).toBe(false);

    // 卸载时必须中止未完成的转写请求（asrAbortRef 清理路径）
    unmount();
    expect(signals[0].aborted).toBe(true);
    // 挂起的管线 promise 保持 pending（mock 永不 resolve），仅引用以防未使用告警
    void stopPromise;
  });

  it("reports ASR failure via SET_ERROR and resets the busy flags", async () => {
    mockTranscribeAudio.mockRejectedValue(new Error("网络错误"));

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });
    await act(async () => {
      await result.current.session.stopRecording();
    });

    // getErrorMessage 提取 Error.message 上报；不写入任何句子结果；
    // 评估通道不应被触发（失败发生在转写阶段）
    expect(result.current.state.error).toBe("网络错误");
    expect(result.current.session.recognizing).toBe(false);
    expect(result.current.session.evaluating).toBe(false);
    expect(mockExecuteEvaluation).not.toHaveBeenCalled();
    expect(result.current.state.results[0]).toBeNull();
  });

  it("reports empty recordings without entering the pipeline", async () => {
    mockStop.mockResolvedValue(null);

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.stopRecording();
    });

    expect(result.current.state.error).toBe("录音太短或没有声音，请重试。");
    expect(mockConvertToWav).not.toHaveBeenCalled();
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(result.current.session.evaluating).toBe(false);
  });

  it("reports evaluation parse failures without writing a sentence result", async () => {
    mockExecuteEvaluation.mockImplementation(
      (
        prompt: string,
        userContent: string,
        overrides?: { onDone?: (fullText: string) => void },
      ) => {
        capturedEvaluation = { prompt, userContent, overrides };
        overrides?.onDone?.("这不是 JSON");
        return Promise.resolve();
      },
    );

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });
    await act(async () => {
      await result.current.session.stopRecording();
    });

    expect(result.current.state.error).toBe("评估解析失败，请重试该句。");
    expect(result.current.state.results[0]).toBeNull();
    expect(result.current.session.evaluating).toBe(false);
  });

  it("forwards evaluation stream errors via SET_ERROR", async () => {
    mockExecuteEvaluation.mockImplementation(
      (prompt: string, userContent: string, overrides?: { onError?: (error: Error) => void }) => {
        capturedEvaluation = { prompt, userContent, overrides };
        overrides?.onError?.(new Error("模型未配置"));
        return Promise.resolve();
      },
    );

    const { result } = renderSessionHarness(1); // 非首句，验证 index 锁定
    await act(async () => {
      await result.current.session.startRecording();
    });
    await act(async () => {
      await result.current.session.stopRecording();
    });

    expect(result.current.state.error).toBe("模型未配置");
    expect(result.current.state.results[0]).toBeNull();
    expect(result.current.state.results[1]).toBeNull();
  });

  it("resets evaluating/recognizing when the evaluation stream is aborted", async () => {
    // 评估流在途：execute 只捕获 overrides、不触发 onDone（模拟流式尚未完成）
    mockExecuteEvaluation.mockImplementation(
      (prompt: string, userContent: string, overrides?: { onAbort?: () => void }) => {
        capturedEvaluation = { prompt, userContent, overrides };
        return Promise.resolve();
      },
    );
    // abort 等价于 use-stream-chat 的真实中止路径：仅触发 onAbort 回调
    mockAbortEvaluation.mockImplementation(() => {
      capturedEvaluation?.overrides?.onAbort?.();
    });

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });
    await act(async () => {
      await result.current.session.stopRecording();
    });

    // 评估在途：evaluating 为 true（录音按钮被锁）
    await waitFor(() => expect(result.current.session.evaluating).toBe(true));

    // 重新开始一轮 → abortSession 先中止在途 ASR（本例中 ASR 已完成，
    // 控制器 abort 无害）再中止评估流
    act(() => {
      result.current.session.abortSession();
    });

    // evaluating / recognizing 必须复位，新一轮 speaking 阶段的录音按钮解锁
    expect(result.current.session.evaluating).toBe(false);
    expect(result.current.session.recognizing).toBe(false);
  });

  it("discards a late ASR result and skips evaluation when the session is aborted mid-transcription", async () => {
    // 修复 3 回归：ASR 在途时重开一轮，晚到的转写必须被静默丢弃——
    // 否则 SET_TRANSCRIPTION 写入新一轮当前句，评估照常发起（多一次计费）
    let resolveAsr!: (text: string) => void;
    let asrSignal: AbortSignal | undefined;
    mockTranscribeAudio.mockImplementation(
      (_blob: Blob, _lang: string, _model: unknown, signal?: AbortSignal) =>
        new Promise<string>((resolve) => {
          asrSignal = signal;
          resolveAsr = resolve;
        }),
    );

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });

    // 不在 act 内 await stopRecording —— transcribeAudio 挂起会让 act 卡死
    let stopPromise: Promise<void> | null = null;
    act(() => {
      stopPromise = result.current.session.stopRecording();
    });
    await waitFor(() => expect(mockTranscribeAudio).toHaveBeenCalledTimes(1));
    expect(asrSignal?.aborted).toBe(false);

    // 重开一轮：abortSession 必须同时中止在途 ASR 与评估流
    act(() => {
      result.current.session.abortSession();
    });
    expect(asrSignal?.aborted).toBe(true);

    // ASR 晚到完成：结果静默丢弃
    await act(async () => {
      resolveAsr("late transcription");
      await stopPromise;
    });

    expect(result.current.state.currentTranscription).toBeNull();
    expect(result.current.state.error).toBeNull();
    expect(mockExecuteEvaluation).not.toHaveBeenCalled();
    // busy 标志复位：recognizing 卡 true 会锁死新一轮的录音按钮
    expect(result.current.session.recognizing).toBe(false);
    expect(result.current.session.evaluating).toBe(false);
  });

  it("stays silent when the aborted ASR request rejects with AbortError", async () => {
    // guardedInvoke 的真实中止语义：invoke 无法取消 Rust 命令，abort 在
    // 请求完成后被观察到，以 AbortError 拒绝——不得报"语音识别失败"
    mockTranscribeAudio.mockImplementation(
      (_blob: Blob, _lang: string, _model: unknown, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });

    let stopPromise: Promise<void> | null = null;
    act(() => {
      stopPromise = result.current.session.stopRecording();
    });
    await waitFor(() => expect(mockTranscribeAudio).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.session.abortSession();
    });
    await act(async () => {
      await stopPromise;
    });

    // 中止不算识别失败：无错误、无转写写入、无评估、busy 标志复位
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.currentTranscription).toBeNull();
    expect(mockExecuteEvaluation).not.toHaveBeenCalled();
    expect(result.current.session.recognizing).toBe(false);
    expect(result.current.session.evaluating).toBe(false);
  });

  it("captures recording start failures", async () => {
    mockStart.mockRejectedValue(new Error("权限被拒"));

    const { result } = renderSessionHarness(0);
    await act(async () => {
      await result.current.session.startRecording();
    });

    expect(result.current.state.error).toBe("权限被拒");
    // 启动失败仍应先清除上一轮的当前句状态
    expect(result.current.state.currentTranscription).toBeNull();
  });

  it("clears the previous sentence state before starting a new recording", async () => {
    const { result } = renderSessionHarness(0);

    // 先完整跑一轮拿到转写与评分
    await act(async () => {
      await result.current.session.startRecording();
    });
    await act(async () => {
      await result.current.session.stopRecording();
    });
    expect(result.current.state.currentTranscription).not.toBeNull();

    // 再次开始录音：CLEAR_CURRENT 应清空上一句展示
    await act(async () => {
      await result.current.session.startRecording();
    });
    expect(result.current.state.currentTranscription).toBeNull();
    expect(result.current.state.currentScore).toBeNull();
  });

  it("locks the evaluation to the sentence being recorded when currentIndex changes mid-recording", async () => {
    // B1 回归：录音期间切句（页面导航守卫之外的 hook 层兜底），停止后的
    // 评估必须仍归属发起录音的第 0 句——否则评分写错句、麦克风晚释放、
    // 平均分与逐句结果/落库数据矛盾
    const { result, rerender } = renderSessionHarness(0);

    await act(async () => {
      await result.current.session.startRecording();
    });

    // 录音在途时 currentIndex 变为 1
    rerender({ index: 1 });

    await act(async () => {
      await result.current.session.stopRecording();
    });

    // 评估用的原句仍是第 0 句；结果只写入第 0 句
    expect(capturedEvaluation?.prompt).toContain("Hello world");
    expect(capturedEvaluation?.prompt).not.toContain("Good morning");
    expect(result.current.state.results[0]).toEqual({
      transcription: "hello world",
      score: expect.objectContaining({ overall: 90 }),
    });
    expect(result.current.state.results[1]).toBeNull();
  });

  it("clears the locked recording index on abortSession so a later stop falls back to currentIndex", async () => {
    // 锁定索引必须随 abortSession 清空：否则新一轮未开麦的停止会沿用
    // 上一轮的陈旧索引，把结果写到已重启会话之外的句子
    const { result, rerender } = renderSessionHarness(0);

    await act(async () => {
      await result.current.session.startRecording();
    });
    act(() => {
      result.current.session.abortSession();
    });
    rerender({ index: 1 });

    await act(async () => {
      await result.current.session.stopRecording();
    });

    // 索引已清空：目标句回退为停止时的 currentIndex（第 1 句）
    expect(capturedEvaluation?.prompt).toContain("Good morning");
    expect(result.current.state.results[1]).not.toBeNull();
  });
});
