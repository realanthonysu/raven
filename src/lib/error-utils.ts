/**
 * 统一错误消息提取工具。
 *
 * Tauri v2 的 invoke() 在 Rust 端返回 Err 时 reject 的是一个序列化后的
 * 普通对象（{ category, message }），而非 Error 实例。因此在 catch 中
 * `err instanceof Error` 为 false，导致真实错误信息被丢弃。
 *
 * 用法：
 * ```ts
 * import { getErrorMessage } from "@/lib/error-utils";
 * try { ... } catch (err) { onError(`操作失败：${getErrorMessage(err)}`); }
 * ```
 */

export function getErrorMessage(err: unknown, fallback = "未知错误"): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    // Tauri v2 序列化的 AppError: { category, message }
    if (typeof obj.message === "string") return obj.message;
    // 有些场景 err 可能是字符串化的 JSON
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.toString === "function" && obj.toString !== Object.prototype.toString) {
      return obj.toString();
    }
  }
  if (typeof err === "string") return err;
  return fallback;
}
