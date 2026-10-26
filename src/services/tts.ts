/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 正式 TTS 音频合成走 Rust 非流式代理（fetch_tts_audio）：配置（base_url/model/
 * voice）与密钥均由代理命令**服务端自读**（DB settings 表 + OS Keychain），前端
 * 仅传文本与语速覆盖参数。音频以 blob URL 缓存在内存中，同一文本+供应商+模型+
 * 音色+语速组合只请求一次。
 *
 * 设置页试听（speakTestText）走 test_tts_audio 试听命令：接受前端传入的**未保存**
 * base_url 与表单新输入 Key（经私网段 SSRF 校验），每次重新合成、不走音频缓存。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import { setTTSSettingBatch } from "@/lib/db";
import { guardedInvoke, raceWithAbort } from "@/lib/request-utils";
import type { TTSConfig } from "@/types";

/** TTS 请求默认超时时间（毫秒）。 */
const DEFAULT_TTS_TIMEOUT_MS = 60_000;

/**
 * 调用 TTS API 获取语音音频数据（正式路径）。
 *
 * 两种 OpenAI 兼容模式（标准 /audio/speech 与 Chat Completions audio modality）
 * 的区分和请求体构造在 Rust 侧完成，前端只拿到解码后的原始 mp3 字节。
 * 配置与 API Key 均由 Rust 代理命令（fetch_tts_audio）服务端自读：base_url/model/
 * voice 不再经 IPC 传入，前端仅传文本与语速覆盖参数。config 仍用于本文件内的
 * 音频缓存键（含 base_url，更换供应商后不命中旧缓存）。
 *
 * @param text - 要朗读的文本
 * @param config - TTS 配置（仅用于 speed 与缓存键，不再参与 IPC 请求）
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
  // 已中止的调用直接拒绝（不发起 IPC），与旧 fetch 路径的 AbortError 语义一致；
  // 统一超时控制：外部 signal 触发或超时都转为可识别的超时错误（guardedInvoke）
  return guardedInvoke({
    signal,
    timeoutMs,
    timeoutMessage: `TTS 请求超时（${timeoutMs / 1000}秒）`,
    doInvoke: () =>
      invoke<ArrayBuffer>("fetch_tts_audio", {
        text,
        speed: config.speed,
        timeoutMs,
      }),
  });
}

/**
 * 试听 TTS 音频（测试设置页**未保存的**表单配置）。
 *
 * 走 `test_tts_audio` 试听命令：接受前端传入未保存的 base_url 与表单新输入的
 * api_key（`config.api_key` 缺省时服务端从 OS Keychain 自读），服务端合成后返回
 * 原始 mp3 字节。试听每次重新合成，**不走 audioUrlCache**（避免污染正式音频缓存）。
 *
 * @param text - 要试听的文本
 * @param config - 表单当前未保存的 TTS 配置（base_url、api_key、model、voice、speed）
 * @param signal - 可选的 AbortSignal（invoke 无法中止命令，abort 仅放弃结果）
 * @param timeoutMs - 请求超时时间（毫秒），默认 60000
 * @returns 音频 ArrayBuffer
 */
export async function testTTSAudio(
  text: string,
  config: { base_url: string; api_key?: string; model: string; voice: string; speed: number },
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  return guardedInvoke({
    signal,
    timeoutMs,
    timeoutMessage: `TTS 请求超时（${timeoutMs / 1000}秒）`,
    doInvoke: () =>
      invoke<ArrayBuffer>("test_tts_audio", {
        input: {
          base_url: config.base_url,
          api_key: config.api_key,
          model: config.model,
          voice: config.voice,
          speed: config.speed,
          text,
        },
        timeoutMs,
      }),
  });
}

/**
 * 试听 TTS 的便捷入口 —— 获取音频 + 播放一步完成（不走正式音频缓存）。
 *
 * 与 speakText 的签名对齐：`testTTSAudio` 合成未保存配置的音频 → 转 blob URL →
 * `playAudio` 播放。播放结束后立即 revoke blob URL，试听不残留缓存。
 *
 * @param text   - 要试听的文本
 * @param config - 表单当前未保存的 TTS 配置
 * @param signal - 可选的 AbortSignal，同时作用于网络请求和播放阶段
 */
export async function speakTestText(
  text: string,
  config: { base_url: string; api_key?: string; model: string; voice: string; speed: number },
  signal?: AbortSignal,
): Promise<void> {
  const arrayBuffer = await testTTSAudio(text, config, signal);
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  try {
    await playAudio(url, signal);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** TTS 音频缓存实例：最多缓存 200 个 blob URL，淘汰时自动 revoke 释放内存。
 *  缓存的 fetcher 不接收任何调用者的 AbortSignal：共享 Promise 若绑定第一个
 *  调用者的 signal，A 中止会令共享 Promise reject 并触发 onEvict 删除条目，
 *  正在等待的 B 会一起失败。调用者侧的中止由 getTTSAudioUrl 用 raceWithAbort
 *  按等待者独立桥接。超时仍由 fetchTTSAudio 内部的 withTimeout 兜底（与
 *  signal 无关），不会传染给其他等待者。 */
const audioUrlCache = createCachedFetcher(
  async (text: string, config: TTSConfig) => {
    const arrayBuffer = await fetchTTSAudio(text, config);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  },
  {
    maxSize: 200,
    /** 缓存键由文本 + 供应商 + 模型 + 音色 + 语速组成。
     *  base_url 必须参与键：更换供应商后沿用同 model/voice 会
     *  继续命中旧供应商缓存的音频。 */
    keyFn: (text: string, config: TTSConfig) =>
      `${text}|${config.base_url}|${config.model}|${config.voice}|${config.speed}`,
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
function invalidateTTSAudioCache(): void {
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
 * 缓存的共享 Promise 不绑定任何调用者的 signal；本函数用 raceWithAbort
 * 为当前等待者独立桥接 abort：signal 中止只拒绝当前调用者，不影响共享
 * 请求与其他等待者。缓存命中时直接返回已有的 blob URL，不发起网络请求。
 */
async function getTTSAudioUrl(
  text: string,
  config: TTSConfig,
  signal?: AbortSignal,
): Promise<string> {
  return raceWithAbort(audioUrlCache.cached(text, config), signal);
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
