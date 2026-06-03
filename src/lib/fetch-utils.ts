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
