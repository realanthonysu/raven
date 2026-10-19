/**
 * 请求守卫工具 —— 跨 services（tts/asr）共享的超时/中止样板与按等待者的 abort 桥接。
 *
 * 两类职责：
 * 1. `guardedInvoke`：统一 TTS/ASR 非流式代理请求的"已中止预检 + withTimeout
 *    合并信号 + 超时/中止竞争拒绝 + finally 清理"样板。超时是真正的等待边界：
 *    底层 invoke 无法取消，但调用者不会无限等待。
 * 2. `raceWithAbort`：为共享 Promise（缓存去重后的请求）挂接单个调用者的
 *    AbortSignal——中止只拒绝当前等待者，不影响共享请求与其他等待者。
 */

import { withTimeout } from "@/lib/fetch-utils";

/** 统一的 AbortError 构造（与 fetch 路径的中止语义保持一致）。 */
function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * 带中止预检与超时守卫的单次请求。
 *
 * 封装 tts.ts / asr.ts 中重复的样板：
 * - signal 已中止时直接拒绝（不发起请求）
 * - 外部 signal 与超时经 withTimeout 合并；请求前后各检查一次合并信号
 * - 超时触发时抛出调用方提供的可读超时错误，其余错误原样传播
 * - finally 中清理定时器与监听器
 *
 * 超时是**真正的等待边界**：doInvoke 与 deadline Promise 竞争，定时器到点
 * 即以 timeoutMessage 拒绝、合并 signal 中止即以 AbortError 拒绝。底层 invoke
 * 无法取消（Rust 命令会继续跑完），但调用者不再无限等待；及时成功后两条
 * 监听都被清理，不会遗留定时器或迟到的 rejection。
 *
 * @param opts.signal      - 可选的外部中止信号（invoke 无法中止命令，abort 仅放弃结果）
 * @param opts.timeoutMs   - 请求超时毫秒数
 * @param opts.timeoutMessage - 超时触发时抛出的错误文案
 * @param opts.doInvoke    - 实际请求（如 invoke(...) 调用）
 */
export async function guardedInvoke<T>(opts: {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
  doInvoke: () => Promise<T>;
}): Promise<T> {
  const { signal, timeoutMs, timeoutMessage, doInvoke } = opts;

  // 已中止的调用直接拒绝（不发起 IPC），与旧 fetch 路径的 AbortError 语义一致
  if (signal?.aborted) {
    throw createAbortError();
  }

  // 外部 signal（用户取消/页面卸载）与超时信号合并；
  // invoke 无法中止命令，abort 仅放弃结果
  const { signal: mergedSignal, isTimeout, cleanup } = withTimeout(timeoutMs, signal);

  // 超时/中止边界 Promise：与 doInvoke() 竞争。两个触发源各自拒绝——
  // 定时器到点以 timeoutMessage，合并 signal 中止以 AbortError。
  // 注意 withTimeout 的同时限时器可能先中止 mergedSignal，此时 catch 中的
  // isTimeout() 会把 AbortError 归一为 timeoutMessage，两种时序结果一致。
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let onMergedAbort: (() => void) | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    onMergedAbort = () => reject(createAbortError());
    if (mergedSignal.aborted) {
      onMergedAbort();
      return;
    }
    mergedSignal.addEventListener("abort", onMergedAbort, { once: true });
  });
  // race 胜出后 deadline 仍可能稍后拒绝：显式消费，避免遗留 unhandled rejection
  deadline.catch(() => {});

  try {
    if (mergedSignal.aborted) {
      throw createAbortError();
    }
    return await Promise.race([doInvoke(), deadline]);
  } catch (err) {
    if (isTimeout()) {
      throw new Error(timeoutMessage);
    }
    throw err;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (onMergedAbort) mergedSignal.removeEventListener("abort", onMergedAbort);
    cleanup();
  }
}

/**
 * 为（可能被多个调用者共享的）Promise 挂接单个等待者的中止信号。
 *
 * 典型场景：缓存的 Promise 去重后由多个调用者共享，Promise 本身不能绑定
 * 任何一个调用者的 signal（否则 A 中止会令共享 Promise reject、殃及其他等待者）。
 * 本函数在等待者侧做桥接：
 * - signal 中止 → 仅当前等待者以 AbortError 拒绝；共享 Promise 与其他等待者不受影响
 * - 共享 Promise 先 settle → 移除 abort 监听器，正常返回/抛出
 * - 未提供 signal 时原样返回（零开销）
 */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
