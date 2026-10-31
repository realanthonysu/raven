/**
 * TTS 服务层 —— 封装文本到语音的 API 调用、缓存和播放。
 *
 * 正式 TTS 音频合成走 Rust 非流式代理（fetch_tts_audio）：配置（base_url/model/
 * voice）与密钥均由代理命令**服务端自读**（DB settings 表 + OS Keychain），前端
 * 仅传文本与语速覆盖参数。音频以 blob URL 缓存在内存中，同一配置版本+文本+语速
 * 组合只请求一次（缓存键含配置版本戳，见 audioUrlCache）；缓存同时受条目数与
 * 总字节上限约束（32MB），淘汰时 revoke blob URL。
 *
 * 设置页试听（speakTestText）走 test_tts_audio 试听命令：接受前端传入的**未保存**
 * base_url 与表单新输入 Key（经私网段 SSRF 校验），每次重新合成、不走音频缓存。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import { getTTSConfigCached, getTTSConfigVersion, setTTSSettingBatch } from "@/lib/db";
import { guardedInvoke, raceWithAbort } from "@/lib/request-utils";
import type { TTSConfig } from "@/types";

/** TTS 请求默认超时时间（毫秒）。 */
const DEFAULT_TTS_TIMEOUT_MS = 60_000;

/**
 * TTS 未配置的规范错误文案（全站唯一来源，对齐 LLM 侧 MODEL_NOT_CONFIGURED_MESSAGE
 * 的单源模式）。speakText 在配置缺失时以此抛错，由播放 hook 经既有 onError 通道上报。
 */
export const TTS_NOT_CONFIGURED_MESSAGE = "请先在设置中配置 TTS API Key 和 Base URL";

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

/** 缓存条目：blob URL + 该音频的原始字节数（供总字节预算计算）。 */
interface CachedAudio {
  /** 播放用的 blob URL（淘汰时必须 revoke） */
  url: string;
  /** 音频字节数（位置见 audioUrlCache 的 sizeOf） */
  bytes: number;
}

/**
 * TTS 音频缓存的总字节上限（S-14）：32MB。
 *
 * `maxSize: 200` 只限制条目数——长文本语料下 200 条音频可达数十 MB
 * （10 秒语音约 40–80KB，长段落可达数百 KB），需要按字节回收。
 * 32MB 约合数百句常规长度语音，足够覆盖连续朗读窗口。
 */
export const TTS_AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** TTS 音频缓存实例：最多 200 个 blob URL 或 32MB 音频字节，先到者触发淘汰；
 *  淘汰时自动 revoke 释放内存（条目数与字节双重上限，S-14）。
 *  缓存的 fetcher 不接收任何调用者的 AbortSignal：共享 Promise 若绑定第一个
 *  调用者的 signal，A 中止会令共享 Promise reject 并触发 onEvict 删除条目，
 *  正在等待的 B 会一起失败。调用者侧的中止由 getTTSAudioUrl 用 raceWithAbort
 *  按等待者独立桥接。超时仍由 fetchTTSAudio 内部的 withTimeout 兜底（与
 *  signal 无关），不会传染给其他等待者。
 *
 *  失效策略（结构性，无跨层手工约定）：缓存键编入 TTS 配置版本戳
 *  （getTTSConfigVersion，lib/db 在配置写入路径上单调自增），配置变更后旧版本
 *  条目自然不再命中；旧条目（含 blob URL）由 maxSize/maxTotalBytes 淘汰回收。 */
const audioUrlCache = createCachedFetcher(
  async (text: string, config: TTSConfig): Promise<CachedAudio> => {
    const arrayBuffer = await fetchTTSAudio(text, config);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    return { url: URL.createObjectURL(blob), bytes: arrayBuffer.byteLength };
  },
  {
    maxSize: 200,
    /** 字节预算：按音频原始字节累计，超限时 FIFO 淘汰最旧条目（并 revoke） */
    maxTotalBytes: TTS_AUDIO_CACHE_MAX_BYTES,
    /** 缓存键 = 配置版本戳 | 文本 | 语速。版本戳覆盖 base_url/model/voice 等
     *  全部配置变更（配置写入唯一路径 setTTSSettingBatch 必经配置缓存失效与
     *  版本戳自增），这些字段不必再入键；speed 仍显式入键——同一配置下调用方
     *  可按语速覆盖请求不同音频。 */
    keyFn: (text: string, config: TTSConfig) => `${getTTSConfigVersion()}|${text}|${config.speed}`,
    sizeOf: (entry) => entry.bytes,
    /** 缓存条目被淘汰时释放 blob URL，防止内存泄漏 */
    onEvict: (entry) => URL.revokeObjectURL(entry.url),
  },
);

/**
 * 保存 TTS 设置。
 *
 * 两级缓存的失效全部结构化，无需本函数编排：
 * - 配置缓存：setTTSSettingBatch 在 finally 中失效并自增配置版本戳（写失败同样失效）；
 * - 音频缓存：键含配置版本戳，配置变更后旧条目自然不再命中（FIFO 淘汰最终回收）。
 */
export async function saveTTSSettings(entries: Array<[string, string]>): Promise<void> {
  await setTTSSettingBatch(entries);
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
  const entry = await raceWithAbort(audioUrlCache.cached(text, config), signal);
  return entry.url;
}

/**
 * 预取 TTS 音频到 blob URL 缓存（S-12）。
 *
 * 供朗读等连续播放场景在上一句播放期间提前合成下一句，隐藏 TTS 合成 RTT。
 * 与 `speakText` 使用完全相同的配置解析、语速覆盖和 `audioUrlCache` 键
 *（配置版本戳 | text | speed），因此真正播放时命中缓存、不会重复请求。
 *
 * 预取是尽力而为：未配置 TTS、网络失败、超时都静默返回，不向用户报错，
 * 也不影响后续 `speakText` 的正常错误通道。
 */
export async function prefetchTTS(text: string, opts?: { speed?: number }): Promise<void> {
  try {
    const config = await getTTSConfigCached();
    if (!config.api_key || !config.base_url) return;
    const speed = opts?.speed;
    const effectiveConfig = speed != null ? { ...config, speed } : config;
    await getTTSAudioUrl(text, effectiveConfig);
  } catch {
    // 预取失败静默：用户主动播放时重试并走既有错误提示路径。
  }
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
 * 语音朗读的便捷入口 —— 配置自取 + 获取音频 + 播放一步完成。
 *
 * TTS 配置由本函数经 `getTTSConfigCached` 自取：SSRF 修复后 fetch_tts_audio
 * 在 Rust 侧服务端自读配置与密钥，配置在浏览器侧仅剩缓存键与语速两类用途，
 * 调用方不再需要先取完整配置。api_key/base_url 缺失时抛
 * `TTS_NOT_CONFIGURED_MESSAGE`（单源文案），由调用方经既有错误通道上报。
 *
 * @param text   - 要朗读的文本
 * @param opts   - 可选覆盖：speed 覆盖 TTS 配置中的默认语速（0.25-4.0）
 * @param signal - 可选的 AbortSignal，同时作用于网络请求和播放阶段
 */
export async function speakText(
  text: string,
  opts?: { speed?: number },
  signal?: AbortSignal,
): Promise<void> {
  const config = await getTTSConfigCached();
  // M-8（沿用播放 hook 时代的校验语义）：配置不完整时不再发起注定失败的网络请求
  if (!config.api_key || !config.base_url) {
    throw new Error(TTS_NOT_CONFIGURED_MESSAGE);
  }
  // 应用速度覆盖（如提供），语速参与音频缓存键
  const speed = opts?.speed;
  const effectiveConfig = speed != null ? { ...config, speed } : config;
  const url = await getTTSAudioUrl(text, effectiveConfig, signal);
  await playAudio(url, signal);
}
