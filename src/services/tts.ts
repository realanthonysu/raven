/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 复用 llm.ts 的双通道 fetch 策略：优先 tauriFetch（绕 CORS），失败回退 WebView fetch。
 * 音频以 blob URL 缓存在内存中，同一文本+音色+语速组合只请求一次。
 */

import { createCachedFetcher } from "@/lib/cache";
import { smartFetch, withTimeout } from "@/lib/fetch-utils";
import { TTSAudioResponseSchema } from "@/lib/schemas";
import type { TTSConfig } from "@/types";

/**
 * 调用 TTS API 获取语音音频数据。
 *
 * 支持两种 OpenAI 兼容模式：
 * 1. `/audio/speech` — 标准 TTS 端点，返回原始音频二进制（OpenAI、Azure 等）
 * 2. `/chat/completions` — Chat Completions audio modality，返回 base64 编码音频
 *    （GPT-4o-audio-preview、mimo-v2.5-tts 等）
 *
 * 通过 base_url 的路径自动判断模式：以 /chat/completions 结尾用模式 2，否则用模式 1。
 */
/** TTS 请求默认超时时间（毫秒）。 */
const DEFAULT_TTS_TIMEOUT_MS = 60_000;

export async function fetchTTSAudio(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  const base = config.base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.api_key}`,
  };

  // 统一超时控制：外部 signal 触发或超时都会中止请求
  const { signal: combinedSignal, isTimeout, cleanup } = withTimeout(timeoutMs, signal);

  // 模式 2：Chat Completions audio modality（mimo / GPT-4o-audio 等）
  if (base.endsWith("/chat/completions")) {
    let body: string;
    if (config.model.startsWith("mimo")) {
      // mimo TTS：assistant 消息 = 要朗读的文本，无 modalities 字段
      body = JSON.stringify({
        model: config.model,
        messages: [{ role: "assistant", content: text }],
        audio: { voice: config.voice, format: "mp3", speed: config.speed },
      });
    } else {
      // OpenAI audio modality（GPT-4o-audio-preview 等）
      body = JSON.stringify({
        model: config.model,
        modalities: ["text", "audio"],
        audio: { voice: config.voice, format: "mp3" },
        messages: [{ role: "user", content: text }],
      });
    }
    try {
      const response = await smartFetch(base, {
        method: "POST",
        headers,
        body,
        signal: combinedSignal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`TTS 请求失败: ${response.status} ${response.statusText} ${errText}`);
      }
      const json = await response.json();
      const parsed = TTSAudioResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error("TTS 响应格式无效，无法解析音频数据");
      }
      return base64ToArrayBuffer(parsed.data.choices[0].message.audio.data);
    } catch (err) {
      if (isTimeout()) {
        throw new Error(`TTS 请求超时（${timeoutMs / 1000}秒）`);
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  // 模式 1：标准 /audio/speech 端点
  const url = base.endsWith("/audio/speech") ? base : `${base}/audio/speech`;
  const body = JSON.stringify({
    model: config.model,
    input: text,
    voice: config.voice,
    speed: config.speed,
  });
  try {
    const response = await smartFetch(url, {
      method: "POST",
      headers,
      body,
      signal: combinedSignal,
    });
    if (!response.ok) {
      throw new Error(`TTS 请求失败: ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (err) {
    if (isTimeout()) {
      throw new Error(`TTS 请求超时（${timeoutMs / 1000}秒）`);
    }
    throw err;
  } finally {
    cleanup();
  }
}

/** 将 base64 字符串解码为 ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** TTS 音频缓存实例：最多缓存 200 个 blob URL，淘汰时自动 revoke 释放内存 */
const audioUrlCache = createCachedFetcher(
  async (text: string, config: TTSConfig, signal?: AbortSignal) => {
    const arrayBuffer = await fetchTTSAudio(text, config, signal);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  },
  {
    maxSize: 200,
    /** 缓存键由文本 + 音色 + 语速组成，确保不同参数组合独立缓存（signal 不参与键） */
    keyFn: (text: unknown, config: unknown) =>
      `${text}|${(config as TTSConfig).model}|${(config as TTSConfig).voice}|${(config as TTSConfig).speed}`,
    /** 缓存条目被淘汰时释放 blob URL，防止内存泄漏 */
    onEvict: (url) => URL.revokeObjectURL(url),
  },
);

/**
 * 获取 TTS 音频的 blob URL（带缓存）。
 *
 * signal 在缓存未命中时传递给底层 fetchTTSAudio，使网络请求可被中止。
 * 缓存命中时直接返回已有的 blob URL，不发起网络请求。
 */
export async function getTTSAudioUrl(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal,
): Promise<string> {
  return audioUrlCache.cached(text, config, signal);
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
