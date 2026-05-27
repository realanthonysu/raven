/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 复用 llm.ts 的双通道 fetch 策略：优先 tauriFetch（绕 CORS），失败回退 WebView fetch。
 * 音频以 blob URL 缓存在内存中，同一文本+音色+语速组合只请求一次。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { TTSConfig } from "@/types";

const audioCache = new Map<string, string>();
const CACHE_MAX_SIZE = 200;

function cacheKey(text: string, voice: string, speed: number): string {
  return `${text}|${voice}|${speed}`;
}

export async function fetchTTSAudio(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal
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

  try {
    const response = await tauriFetch(url, init);
    if (!response.ok) {
      throw new Error(`TTS 请求失败: ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (tauriError) {
    if (signal?.aborted) throw tauriError;
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`TTS 请求失败: ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  }
}

export async function getTTSAudioUrl(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal
): Promise<string> {
  const key = cacheKey(text, config.voice, config.speed);
  const cached = audioCache.get(key);
  if (cached) return cached;

  const arrayBuffer = await fetchTTSAudio(text, config, signal);
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
  const blobUrl = URL.createObjectURL(blob);

  // LRU eviction: remove oldest entries when cache exceeds limit
  if (audioCache.size >= CACHE_MAX_SIZE) {
    const firstKey = audioCache.keys().next().value;
    if (firstKey !== undefined) {
      const evicted = audioCache.get(firstKey);
      if (evicted) URL.revokeObjectURL(evicted);
      audioCache.delete(firstKey);
    }
  }

  audioCache.set(key, blobUrl);
  return blobUrl;
}

export function playAudio(url: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);

    const onAbort = () => {
      audio.pause();
      audio.currentTime = 0;
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    if (signal?.aborted) {
      signal.removeEventListener("abort", onAbort);
      resolve();
      return;
    }

    audio.onended = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    audio.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("音频播放失败"));
    };
    audio.play().catch(err => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

export async function speakText(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal
): Promise<void> {
  const url = await getTTSAudioUrl(text, config, signal);
  await playAudio(url, signal);
}
