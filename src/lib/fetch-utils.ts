import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 双通道 fetch 策略：优先使用 Tauri HTTP 插件（绕过 CORS），失败时回退到 WebView fetch。
 */
export async function smartFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await tauriFetch(url, init);
  } catch {
    // Tauri HTTP 插件不可用时（如 web 端开发、插件未注册等），
    // 回退到 WebView 原生 fetch（受 CORS 限制，但无需原生桥接）
    return fetch(url, init);
  }
}
