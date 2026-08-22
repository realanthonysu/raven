import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getErrorMessage } from "@/lib/error-utils";

/**
 * 双通道 fetch 策略：优先使用 Tauri HTTP 插件（绕过 CORS），失败时回退到 WebView fetch。
 *
 * 仅在 Tauri HTTP 插件不可用时（如 web 端开发、插件未注册）才回退到 WebView fetch。
 * 其他错误（网络故障、DNS 解析失败等）直接抛出，避免掩盖真实问题。
 *
 * E2: 插件可用性以特性检测为主判断（`__TAURI_INTERNALS__` 存在即 Tauri 运行时），
 * 错误消息字符串判断仅作辅助——Tauri 版本升级可能改变错误措辞导致误判。
 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// 网络层错误特征：任一命中即判定为真实网络故障，不降级到 WebView fetch
const NETWORK_ERROR_PATTERN =
  /(network\s*(error|changed)|failed to fetch|load failed|dns|timed?\s*out|timeout|connection\s*(refused|reset|closed|aborted)|socket|tls|ssl|certificate)/i;

/**
 * 判断 tauriFetch 抛出的错误是否为"Tauri HTTP 插件不可用"。
 *
 * 识别策略（按顺序）：
 * 1. 非 Tauri 运行时（web 端开发）→ 插件必然不可用，回退。
 * 2. 网络层特征优先排除：错误消息命中网络/DNS/超时/TLS 等特征，
 *    或是 WebView/reqwest 网络层典型的 TypeError —— 这类错误必须直接抛出，
 *    绝不降级到 WebView fetch，避免掩盖真实网络问题。
 * 3. 剩余情况再匹配插件缺失的特征码（invoke 桥未注入 / 插件未注册），
 *    且要求 err instanceof Error 以收窄匹配面。
 */
function isPluginUnavailableError(err: unknown): boolean {
  if (!isTauriRuntime()) return true;
  const msg = getErrorMessage(err, "").toLowerCase();
  if (!msg) return false;

  // 网络层错误特征：任一命中即判定为真实网络故障，不降级。
  // TypeError 是 fetch 网络失败（Failed to fetch / Load failed）的典型构造类型
  if (err instanceof TypeError || NETWORK_ERROR_PATTERN.test(msg)) return false;

  // 插件缺失特征码：invoke 桥未注入或插件未注册（措辞随 Tauri 版本可能变化，
  // 因此只作辅助判断，且已被上面的网络层排除条件收窄）
  const pluginPatterns = [
    "not registered",
    "not loaded",
    "plugin not found",
    "__tauri__ is not defined",
    "__tauri_internals__ is not defined",
    "no such command",
  ];
  return pluginPatterns.some((p) => msg.includes(p));
}

export async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await tauriFetch(url, init);
  } catch (err) {
    // 仅在插件不可用时回退，其他错误（网络故障、DNS 解析失败等）直接抛出
    if (!isPluginUnavailableError(err)) throw err;
    console.warn(
      "Tauri HTTP plugin unavailable, falling back to WebView fetch:",
      getErrorMessage(err, String(err)),
    );
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

/**
 * 可被 AbortSignal 中断的延迟。
 *
 * 用于重试逻辑中的等待间隔：若在等待期间收到中止信号，
 * 立即清除定时器并 resolve（而非 reject），让调用方检查 `signal.aborted` 后安全退出。
 *
 * @param ms - 延迟毫秒数
 * @param signal - 可选的中止信号
 * @returns Promise 在延迟到期或 signal 中止后 resolve
 */
export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
