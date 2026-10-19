/**
 * request-utils test suite.
 *
 * guardedInvoke：TTS/ASR 非流式代理请求的统一守卫。
 * 核心语义：超时是**真正的等待边界**——doInvoke 与 deadline Promise 竞争，
 * 定时器到点以 timeoutMessage 拒绝、合并 signal 中止以 AbortError 拒绝；
 * 底层 invoke 虽无法取消，调用者不再无限等待，且不吞掉真实错误。
 *
 * raceWithAbort：共享 Promise 的按等待者 abort 桥接（缓存去重场景）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedInvoke, raceWithAbort } from "./request-utils";

describe("guardedInvoke", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the result when doInvoke settles in time", async () => {
    const result = await guardedInvoke({
      timeoutMs: 50,
      timeoutMessage: "请求超时（50秒）",
      doInvoke: async () => "ok",
    });

    expect(result).toBe("ok");
  });

  it("leaves no pending timer after a timely success", async () => {
    vi.useFakeTimers();

    const result = await guardedInvoke({
      timeoutMs: 10,
      timeoutMessage: "请求超时（10秒）",
      doInvoke: async () => "quick",
    });
    expect(result).toBe("quick");

    // 超时定时器已被清理：越过截止时间也不应产生拒绝或 unhandled rejection
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("rejects with the timeout message when doInvoke never settles", async () => {
    // 核心：超时成为真正的等待边界——此前 doInvoke 永久挂起会让调用方无限等待
    vi.useFakeTimers();

    const promise = guardedInvoke({
      timeoutMs: 10,
      timeoutMessage: "语音识别请求超时（60秒）",
      doInvoke: () => new Promise<never>(() => {}),
    });
    const assertion = expect(promise).rejects.toThrow("语音识别请求超时（60秒）");

    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("keeps the timeout rejection even if doInvoke settles later", async () => {
    vi.useFakeTimers();

    let resolveLate!: (value: string) => void;
    const promise = guardedInvoke({
      timeoutMs: 10,
      timeoutMessage: "TTS 请求超时（60秒）",
      doInvoke: () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    });
    const assertion = expect(promise).rejects.toThrow("TTS 请求超时（60秒）");

    await vi.advanceTimersByTimeAsync(10);
    await assertion;

    // 迟到的成功不应 resurrect 已拒绝的结果，也不产生 unhandled rejection
    resolveLate("too late");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("rejects with AbortError when the external signal aborts", async () => {
    const controller = new AbortController();

    const promise = guardedInvoke({
      signal: controller.signal,
      timeoutMs: 60_000,
      timeoutMessage: "TTS 请求超时（60秒）",
      doInvoke: () => new Promise<never>(() => {}),
    });
    controller.abort();

    let caught: unknown;
    await promise.catch((err) => {
      caught = err;
    });
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("rejects immediately when the signal is already aborted (doInvoke never called)", async () => {
    const controller = new AbortController();
    controller.abort();
    const doInvoke = vi.fn(async () => "ok");

    let caught: unknown;
    await guardedInvoke({
      signal: controller.signal,
      timeoutMs: 50,
      timeoutMessage: "请求超时（50秒）",
      doInvoke,
    }).catch((err) => {
      caught = err;
    });

    expect((caught as DOMException).name).toBe("AbortError");
    expect(doInvoke).not.toHaveBeenCalled();
  });

  it("propagates real doInvoke errors without swallowing them", async () => {
    await expect(
      guardedInvoke({
        timeoutMs: 50,
        timeoutMessage: "请求超时（50秒）",
        doInvoke: async () => {
          throw new Error("IPC 失败");
        },
      }),
    ).rejects.toThrow("IPC 失败");
  });
});

describe("raceWithAbort", () => {
  it("returns the promise unchanged when no signal is provided", async () => {
    await expect(raceWithAbort(Promise.resolve("v"))).resolves.toBe("v");
  });

  it("rejects the waiting caller with AbortError while the shared promise keeps running", async () => {
    const controller = new AbortController();
    let resolveShared!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      resolveShared = resolve;
    });

    const raced = raceWithAbort(shared, controller.signal);
    controller.abort();

    let caught: unknown;
    await raced.catch((err) => {
      caught = err;
    });
    expect((caught as DOMException).name).toBe("AbortError");

    // 共享 Promise 与其他等待者不受影响
    resolveShared("done");
    await expect(shared).resolves.toBe("done");
  });

  it("resolves with the shared value when it settles before the abort", async () => {
    const controller = new AbortController();

    await expect(raceWithAbort(Promise.resolve("shared"), controller.signal)).resolves.toBe(
      "shared",
    );
  });
});
