/**
 * 键值对设置操作。
 */

import { invoke } from "@tauri-apps/api/core";

import { DEFAULT_LEVEL, isLevelCode, type LevelCode } from "@/lib/levels";

/**
 * 查询单个设置项的值。
 *
 * @param key - 设置键名
 * @returns 设置值，不存在时返回 null
 */
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("db_get_setting", { key });
}

/**
 * 设置/更新一个键值对（Upsert 语义：存在则更新，不存在则插入）。
 *
 * @param key - 设置键名
 * @param value - 设置值
 */
export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("db_set_setting", { key, value });
}

// ============================================================================
// 英语水平级别（proficiency_level）—— 类型化封装
// ============================================================================

/** settings 表中存储 CEFR 级别码的键名 */
export const PROFICIENCY_LEVEL_KEY = "proficiency_level";

/**
 * 读取用户英语水平级别。
 *
 * 未设置/值非法/读取失败时返回 DEFAULT_LEVEL（fail-soft：设置读取异常
 * 不应阻塞练习页面的 prompt 构建）。
 */
export async function getProficiencyLevel(): Promise<LevelCode> {
  try {
    const v = await getSetting(PROFICIENCY_LEVEL_KEY);
    return isLevelCode(v) ? v : DEFAULT_LEVEL;
  } catch (e) {
    console.warn("[db] getProficiencyLevel 失败，回退默认级别:", e);
    return DEFAULT_LEVEL;
  }
}

/** 写入用户英语水平级别（Upsert） */
export async function setProficiencyLevel(level: LevelCode): Promise<void> {
  await setSetting(PROFICIENCY_LEVEL_KEY, level);
}
