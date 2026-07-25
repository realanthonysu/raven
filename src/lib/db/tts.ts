/**
 * TTS/ASR 配置操作（API Key 由 Rust 端自动存取到 OS Keychain）。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import type { TTSConfig } from "@/types";
import { getSetting, setSetting } from "./settings";
import type { TtsConfigDto } from "./utils";

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

const ttsConfigCache = createCachedFetcher(getTTSConfig);
export const getTTSConfigCached = ttsConfigCache.cached;
export const invalidateTTSConfigCache = (): void => ttsConfigCache.invalidate();

/** 写入单个 TTS 设置但不立即失效缓存（供批量操作使用） */
async function setTTSSettingNoInvalidate(key: string, value: string): Promise<void> {
  await invoke<void>("db_set_tts_setting", { key, value });
}

/** 批量写入多个 TTS 设置，全部成功后统一失效缓存一次 */
export async function setTTSSettingBatch(entries: Array<[string, string]>): Promise<void> {
  await Promise.all(entries.map(([key, value]) => setTTSSettingNoInvalidate(key, value)));
  invalidateTTSConfigCache();
}

// ============================================================================
// ASR 配置（复用 TTS 的 base_url 和 api_key，仅模型名不同）
// ============================================================================

export async function getASRModel(): Promise<string> {
  return (await getSetting("asr_model")) || "mimo-v2.5-asr";
}

export async function setASRModel(model: string): Promise<void> {
  await setSetting("asr_model", model);
}
