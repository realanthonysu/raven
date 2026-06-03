/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 复用 llm.ts 的双通道 fetch 策略：优先 tauriFetch（绕 CORS），失败回退 WebView fetch。
 * 音频以 blob URL 缓存在内存中，同一文本+音色+语速组合只请求一次。
 */

import { createCachedFetcher } from "@/lib/cache";
import { smartFetch } from "@/lib/fetch-utils";
import type { TTSConfig } from "@/types";

/**
 * 调用 TTS API 获取语音音频数据。
 *
 * 使用 OpenAI 兼容的 `/audio/speech` 端点，通过 `smartFetch` 双通道策略发送请求。
 *
 * @param text   - 要转换为语音的文本
 * @param config - TTS 配置，包含 base_url、api_key、voice、speed
 * @param signal - 可选的 AbortSignal，用于取消请求
 * @returns Promise<ArrayBuffer> 原始音频二进制数据（audio/mpeg 格式）
 * @throws 请求失败或响应状态非 2xx 时抛出 Error
 */
export async function fetchTTSAudio(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = `${config.base_url}/audio/speech`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: config.voice,
      speed: config.speed,
    }),
    signal,
  };

  const response = await smartFetch(url, init);
  if (!response.ok) {
    throw new Error(`TTS 请求失败: ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

/** TTS 音频缓存实例：最多缓存 200 个 blob URL，淘汰时自动 revoke 释放内存 */
const audioUrlCache = createCachedFetcher(
  async (text: string, config: TTSConfig) => {
    const arrayBuffer = await fetchTTSAudio(text, config);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  },
  {
    maxSize: 200,
    /** 缓存键由文本 + 音色 + 语速组成，确保不同参数组合独立缓存 */
    keyFn: (text: unknown, config: unknown) =>
      `${text}|${(config as TTSConfig).voice}|${(config as TTSConfig).speed}`,
    /** 缓存条目被淘汰时释放 blob URL，防止内存泄漏 */
    onEvict: (url) => URL.revokeObjectURL(url),
  },
);

/**
 * 获取 TTS 音频的 blob URL（带缓存）。
 *
 * signal 参数保留以维持向后兼容，但仅在缓存未命中时有意义。
 * 缓存命中时直接返回已有的 blob URL，不发起网络请求。
 */
export async function getTTSAudioUrl(
  text: string,
  config: TTSConfig,
  _signal?: AbortSignal,
): Promise<string> {
  return audioUrlCache.cached(text, config);
}

/**
 * 播放指定 URL 的音频。
 *
 * 返回一个 Promise，在音频播放完成时 resolve，出错或被中止时 reject。
 * Promise 内部生命周期：
 * 1. 创建 Audio 元素并注册三类回调
 * 2. 如果 signal 已处于 aborted 状态，立即 reject（AbortError）
 * 3. 监听 signal 的 abort 事件以支持外部取消
 * 4. 三条结束路径（互斥），每条都先执行 cleanup 移除所有监听器：
 *    - 正常播放结束（onended）→ resolve
 *    - 播放出错（onerror）→ reject with Error
 *    - 外部中止（abort）→ reject with AbortError
 * 5. audio.play() 本身也可能 reject（例如浏览器自动播放策略阻止），同样处理
 *
 * @param url    - 音频的 blob URL 或远程 URL
 * @param signal - 可选的 AbortSignal，用于取消播放
 * @returns Promise<void> 播放完成时 resolve
 */
export function playAudio(url: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);

    /** 统一清理：移除 signal 监听器和 audio 回调，防止内存泄漏和重复触发 */
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      audio.onended = null;
      audio.onerror = null;
    };

    /** abort 回调：暂停播放、重置进度、清理资源后 reject */
    const onAbort = () => {
      audio.pause();
      audio.currentTime = 0;
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // 检查 signal 是否在注册监听器之前就已经被中止（竞态条件防护）
    if (signal?.aborted) {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    /** 正常播放结束 → 清理并 resolve */
    audio.onended = () => {
      cleanup();
      resolve();
    };

    /** 播放出错 → 清理并 reject */
    audio.onerror = () => {
      cleanup();
      reject(new Error("音频播放失败"));
    };

    // play() 返回 Promise，可能因自动播放策略等原因失败
    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * 语音朗读的便捷入口 —— 获取音频 + 播放一步完成。
 *
 * 先通过 `getTTSAudioUrl` 获取（或命中缓存）blob URL，
 * 再通过 `playAudio` 播放音频。支持通过 signal 全程取消。
 *
 * @param text   - 要朗读的文本
 * @param config - TTS 配置
 * @param signal - 可选的 AbortSignal，同时作用于网络请求和播放阶段
 */
export async function speakText(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal,
): Promise<void> {
  const url = await getTTSAudioUrl(text, config, signal);
  await playAudio(url, signal);
}
