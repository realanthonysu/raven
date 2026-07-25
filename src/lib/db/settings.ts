/**
 * 键值对设置操作。
 */

import { invoke } from "@tauri-apps/api/core";

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
