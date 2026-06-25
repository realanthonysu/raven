import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 双通道 fetch 策略：优先使用 Tauri HTTP 插件（绕过 CORS），失败时回退到 WebView fetch。
 *
 * 仅在 Tauri HTTP 插件不可用时（如 web 端开发、插件未注册）才回退到 WebView fetch。
 * 其他错误（网络故障、DNS 解析失败等）直接抛出，避免掩盖真实问题。
 */
export async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await tauriFetch(url, init);
  } catch (err) {
    // 仅在插件不可用时回退，其他错误直接抛出
    const msg = err instanceof Error ? err.message : String(err);
    const isPluginUnavailable =
      msg.includes("not registered") ||
      msg.includes("not loaded") ||
      msg.includes("__TAURI__ is not defined") ||
      msg.includes("plugin not found");
    if (!isPluginUnavailable) throw err;
    console.warn("Tauri HTTP plugin unavailable, falling back to WebView fetch:", msg);
    return fetch(url, init);
  }
}

/**
 * 创建带超时的 AbortController 组合。
 *
 * R8: 统一 llm.ts (streamChat) 和 asr.ts (transcribeAudio) 中重复的超时控制样板：
 * - 创建独立的 timeout controller
 * - 可选与外部 signal 合并（用户主动中止 + 超时自动中止，任一触发即生效）
 * - 提供 isTimeout() 区分"超时触发"与"用户主动中止"，便于上层给出准确错误提示
 * - cleanup() 清理 setTimeout 定时器和 abort 事件监听器，防止内存泄漏
 *
 * @param timeoutMs - 超时毫秒数
 * @param externalSignal - 可选的外部中止信号（如用户主动取消）
 * @returns
 *   - `signal` — 合并后的中止信号，传入 fetch / readSSEStream
 *   - `isTimeout()` — 返回 true 表示由超时触发（而非外部 signal 触发）
 *   - `cleanup()` — 清理定时器和监听器，必须在 finally 中调用
 *
 * @example
 * ```ts
 * const { signal, isTimeout, cleanup } = withTimeout(60_000, userSignal);
 * try {
 *   const res = await smartFetch(url, { signal });
 *   // ...
 * } catch (err) {
 *   if (isTimeout()) throw new Error("请求超时（60秒）");
 *   throw err;
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function withTimeout(timeoutMs: number, externalSignal?: AbortSignal) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // 若外部 signal 已中止或后续中止，传播到 timeoutController
  let onExternalAbort: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutController.abort();
    } else {
      onExternalAbort = () => timeoutController.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    /** 合并后的中止信号，传入 fetch 或流式读取函数 */
    signal: timeoutController.signal,
    /** 返回 true 表示由超时触发（而非外部 signal 触发） */
    isTimeout: () => timeoutController.signal.aborted && !externalSignal?.aborted,
    /** 清理 setTimeout 定时器和 abort 事件监听器，必须在 finally 中调用 */
    cleanup: () => {
      clearTimeout(timeoutId);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}
