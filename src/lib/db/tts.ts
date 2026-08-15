/**
 * TTS/ASR 配置操作。
 *
 * TTS 配置（base_url、api_key、model、voice、speed）的 API Key 由 Rust 端存取到 OS Keychain。
 * ASR 配置（model）存储在 settings 表中，复用 TTS 的 base_url 和 api_key。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
// services 层的反向引用在此是受控例外：音频缓存失效必须与配置写入同点触发，
// 否则更换供应商后旧音频仍从缓存命中（services/tts.ts 不依赖本模块，无循环依赖）
import { invalidateTTSAudioCache } from "@/services/tts";
import type { TTSConfig } from "@/types";
import { getSetting, setSetting } from "./settings";
import type { TtsConfigDto } from "./utils";

/**
 * 查询 TTS 配置（base_url、api_key、model、voice、speed）。
 *
 * API Key 从 OS Keychain 读取，其余字段从 settings 表读取。
 *
 * @returns TTS 配置对象
 */
export async function getTTSConfig(): Promise<TTSConfig> {
  const dto = await invoke<TtsConfigDto>("db_get_tts_config");
  return {
    base_url: dto.base_url,
    api_key: dto.api_key,
    model: dto.model,
    voice: dto.voice,
    speed: dto.speed,
  };
}

/** TTS 配置缓存实例（避免重复 IPC 查询） */
const ttsConfigCache = createCachedFetcher(getTTSConfig);
/** 获取缓存的 TTS 配置（首次调用查询，后续直接返回缓存） */
export const getTTSConfigCached = ttsConfigCache.cached;
/** 失效 TTS 配置缓存（settings 变更后调用） */
export const invalidateTTSConfigCache = (): void => ttsConfigCache.invalidate();

/** 批量写入多个 TTS 设置（Rust 端单事务 + 单次 IPC，消除逐条写入的部分写入窗口）。
 *  无论成功失败都失效缓存：部分写入后供应商可能已变化，宁可贵一次重新合成。 */
export async function setTTSSettingBatch(entries: Array<[string, string]>): Promise<void> {
  try {
    await invoke<void>("db_set_tts_settings_batch", { entries });
  } finally {
    invalidateTTSConfigCache();
    invalidateTTSAudioCache();
  }
}

// ============================================================================
// ASR 配置（复用 TTS 的 base_url 和 api_key，仅模型名不同）
// ============================================================================

/**
 * 查询 ASR 模型名称。
 *
 * ASR 复用 TTS 的 base_url 和 api_key，仅模型名不同。
 * 未配置时返回默认值 "mimo-v2.5-asr"。
 *
 * @returns ASR 模型名称
 */
export async function getASRModel(): Promise<string> {
  return (await getSetting("asr_model")) || "mimo-v2.5-asr";
}

/**
 * 设置 ASR 模型名称。
 *
 * @param model - ASR 模型名称
 */
export async function setASRModel(model: string): Promise<void> {
  await setSetting("asr_model", model);
}
