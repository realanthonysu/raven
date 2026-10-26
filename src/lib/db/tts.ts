/**
 * TTS/ASR 配置操作。
 *
 * TTS 配置（base_url、api_key、model、voice、speed、dialect）的 API Key 由 Rust 端存取到 OS Keychain。
 * ASR 配置（model）存储在 settings 表中，复用 TTS 的 base_url 和 api_key。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import type { TTSConfig } from "@/types";
import { getSetting, setSetting } from "./settings";
import { SETTINGS_KEYS } from "./settings-keys";
import type { TtsConfigDto } from "./utils";

/**
 * 查询 TTS 配置（base_url、api_key、model、voice、speed、dialect）。
 *
 * API Key 从 OS Keychain 读取，其余字段从 settings 表读取（dialect 缺省回退 "mimo"）。
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
    dialect: dto.dialect || "mimo",
  };
}

/** TTS 配置缓存实例（避免重复 IPC 查询） */
const ttsConfigCache = createCachedFetcher(getTTSConfig);
/** 获取缓存的 TTS 配置（首次调用查询，后续直接返回缓存） */
export const getTTSConfigCached = ttsConfigCache.cached;

/**
 * TTS 配置版本戳：每次配置缓存失效时单调自增。
 *
 * 单调性即全部语义——只需区分"配置变过没有"，不承载任何具体值。services 层
 * （services/tts）把它编入音频缓存键：配置变更（含写失败的部分写入，见下方
 * setTTSSettingBatch 的 finally）后旧版本条目自然不再命中，"保存 TTS 设置必须
 * 失效两级缓存"的不变量由键结构保证，不再依赖 services 层记得手工失效音频缓存。
 */
let ttsConfigVersion = 0;

/** 当前 TTS 配置版本戳（仅供 services/tts 编入音频缓存键，无其他语义）。 */
export const getTTSConfigVersion = (): number => ttsConfigVersion;

/** 失效 TTS 配置缓存（settings 变更后调用），并自增配置版本戳 */
export const invalidateTTSConfigCache = (): void => {
  ttsConfigCache.invalidate();
  ttsConfigVersion += 1;
};

/** 批量写入多个 TTS 设置（Rust 端单事务 + 单次 IPC，消除逐条写入的部分写入窗口）。
 *  无论成功失败都失效缓存并自增版本戳：部分写入后供应商可能已变化，宁可贵一次
 *  重新合成。音频缓存的失效经版本戳键在 services 层结构性完成（见 getTTSConfigVersion）。 */
export async function setTTSSettingBatch(entries: Array<[string, string]>): Promise<void> {
  try {
    await invoke<void>("db_set_tts_settings_batch", { entries });
  } finally {
    invalidateTTSConfigCache();
  }
}

// ============================================================================
// ASR 配置（复用 TTS 的 base_url，仅模型名不同）
// ============================================================================

/**
 * 查询 ASR 模型名称。
 *
 * ASR 复用 TTS 的 base_url，仅模型名不同。
 * 未配置时返回默认值 "mimo-v2.5-asr"。
 *
 * @returns ASR 模型名称
 */
export async function getASRModel(): Promise<string> {
  return (await getSetting(SETTINGS_KEYS.asrModel)) || "mimo-v2.5-asr";
}

/**
 * 设置 ASR 模型名称。
 *
 * @param model - ASR 模型名称
 */
export async function setASRModel(model: string): Promise<void> {
  await setSetting(SETTINGS_KEYS.asrModel, model);
}
