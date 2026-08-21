/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 音频合成走 Rust 非流式代理（db_fetch_tts_audio）：capabilities http scope
 * 收窄为本地回环后，WebView 不再直连远程 TTS API。音频以 blob URL 缓存在内存中，
 * 同一文本+音色+语速组合只请求一次。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import { setTTSSettingBatch } from "@/lib/db";
import { withTimeout } from "@/lib/fetch-utils";
import type { TTSConfig } from "@/types";

/** TTS 请求默认超时时间（毫秒）。 */
const DEFAULT_TTS_TIMEOUT_MS = 60_000;

/**
 * 调用 TTS API 获取语音音频数据。
 *
 * 两种 OpenAI 兼容模式（标准 /audio/speech 与 Chat Completions audio modality）
 * 的区分和请求体构造在 Rust 侧完成，前端只拿到解码后的原始 mp3 字节。
 * API Key 由 Rust 代理命令自行从 OS Keychain 读取，不经 WebView 传递。
 *
 * @param text - 要朗读的文本
 * @param config - TTS 配置（base_url、model、voice、speed；api_key 不参与请求）
 * @param signal - 可选的 AbortSignal（invoke 无法中止命令，abort 仅放弃结果）
 * @param timeoutMs - 请求超时时间（毫秒），默认 60000
 * @returns 音频 ArrayBuffer
 */
export async function fetchTTSAudio(
  text: string,
  config: Omit<TTSConfig, "api_key">,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  // 已中止的调用直接拒绝（不发起 IPC），与旧 fetch 路径的 AbortError 语义一致
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  // 统一超时控制：外部 signal 触发或超时都转为可识别的超时错误
  const { signal: combinedSignal, isTimeout, cleanup } = withTimeout(timeoutMs, signal);

  try {
    if (combinedSignal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const audio = await invoke<ArrayBuffer>("db_fetch_tts_audio", {
      baseUrl: config.base_url,
      model: config.model,
      voice: config.voice,
      speed: config.speed,
      text,
      timeoutMs,
    });
    if (combinedSignal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return audio;
  } catch (err) {
    if (isTimeout()) {
      throw new Error(`TTS 请求超时（${timeoutMs / 1000}秒）`);
    }
    throw err;
  } finally {
    cleanup();
  }
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
    /** 缓存键由文本 + 供应商 + 模型 + 音色 + 语速组成（signal 不参与键）。
     *  base_url 必须参与键：更换供应商后沿用同 model/voice 会
     *  继续命中旧供应商缓存的音频。 */
    keyFn: (text: unknown, config: unknown) => {
      const c = config as TTSConfig;
      return `${text}|${c.base_url}|${c.model}|${c.voice}|${c.speed}`;
    },
    /** 缓存条目被淘汰时释放 blob URL，防止内存泄漏 */
    onEvict: (url) => URL.revokeObjectURL(url),
  },
);

/**
 * 失效全部 TTS 音频缓存（并 revoke 对应 blob URL）。
 *
 * TTS 配置变更后必须调用：否则旧供应商/旧音色的音频会继续从缓存命中。
 * 注意：若某条音频正在播放，revoke 不影响已加载到 Audio 元素的内容，
 * 仅阻止后续通过该 URL 的重新加载。
 */
export function invalidateTTSAudioCache(): void {
  audioUrlCache.invalidate();
}

/**
 * 保存 TTS 设置并失效音频缓存。
 *
 * "配置写入 + 音频缓存失效"的编排放在服务层（lib/db 不反向依赖 services）：
 * 无论成功失败都失效——部分写入后供应商可能已变化，宁可贵一次重新合成，
 * 与 setTTSSettingBatch 内部的配置缓存失效语义保持一致。
 */
export async function saveTTSSettings(entries: Array<[string, string]>): Promise<void> {
  try {
    await setTTSSettingBatch(entries);
  } finally {
    invalidateTTSAudioCache();
  }
}

/**
 * 获取 TTS 音频的 blob URL（带缓存）。
 *
 * signal 在缓存未命中时传递给底层 fetchTTSAudio，使网络请求可被中止。
 * 缓存命中时直接返回已有的 blob URL，不发起网络请求。
 */
async function getTTSAudioUrl(
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
function playAudio(url: string, signal?: AbortSignal): Promise<void> {
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
