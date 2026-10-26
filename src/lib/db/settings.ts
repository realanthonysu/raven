/**
 * 键值对设置操作。
 *
 * settings key 的字面量单一来源是 `./settings-keys` 的 `SETTINGS_KEYS`
 * （与 Rust ALLOWED_SETTINGS 由契约测试锁定一致）；本模块提供 getSetting/
 * setSetting 两个原始通道（wrapper 内部使用）与按 key 的类型化封装。
 * 新增设置项时：SETTINGS_KEYS 登记一项 + Rust 白名单登记一行 +（按需）
 * 在此照既有 wrapper 模式补一个类型化封装。
 */

import { invoke } from "@tauri-apps/api/core";

import { DEFAULT_LEVEL, isLevelCode, type LevelCode } from "@/lib/levels";
import { extractJsonSafe } from "@/lib/parse-utils";
import { type PlacementResult, PlacementResultSchema } from "@/lib/schemas";
import { SETTINGS_KEYS } from "./settings-keys";

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

/**
 * 读取用户英语水平级别。
 *
 * 未设置/值非法/读取失败时返回 DEFAULT_LEVEL（fail-soft：设置读取异常
 * 不应阻塞练习页面的 prompt 构建）。
 */
export async function getProficiencyLevel(): Promise<LevelCode> {
  try {
    const v = await getSetting(SETTINGS_KEYS.proficiencyLevel);
    return isLevelCode(v) ? v : DEFAULT_LEVEL;
  } catch (e) {
    console.warn("[db] getProficiencyLevel 失败，回退默认级别:", e);
    return DEFAULT_LEVEL;
  }
}

/** 写入用户英语水平级别（Upsert） */
export async function setProficiencyLevel(level: LevelCode): Promise<void> {
  await setSetting(SETTINGS_KEYS.proficiencyLevel, level);
}

// ============================================================================
// AI 定级测试结果（placement_result）
// ============================================================================

/**
 * 读取最近一次 AI 定级测试结果。
 *
 * 未测试 / JSON 损坏 / 结构不符时返回 null（fail-soft：旧版本数据
 * 或手改 settings 不应阻塞设置页渲染）。
 */
export async function getPlacementResult(): Promise<PlacementResult | null> {
  try {
    const raw = await getSetting(SETTINGS_KEYS.placementResult);
    if (!raw) return null;
    return extractJsonSafe(raw, PlacementResultSchema);
  } catch (e) {
    console.warn("[db] getPlacementResult 失败:", e);
    return null;
  }
}

/** 写入最近一次定级测试结果（整体替换,只保留最新一次） */
export async function setPlacementResult(result: PlacementResult): Promise<void> {
  await setSetting(SETTINGS_KEYS.placementResult, JSON.stringify(result));
}

// ============================================================================
// 首次启动引导（onboarding_done）
// ============================================================================

/**
 * 读取首次启动引导是否已完成。
 *
 * wire 契约：只在完成时写 "true"；未设置或其他任何值均视为未完成
 * （App.tsx 既有判定 `done !== "true"` 的等价封装）。
 */
export async function getOnboardingDone(): Promise<boolean> {
  return (await getSetting(SETTINGS_KEYS.onboardingDone)) === "true";
}

/** 标记首次启动引导已完成（wire 值固定 "true"） */
export async function setOnboardingDone(): Promise<void> {
  await setSetting(SETTINGS_KEYS.onboardingDone, "true");
}

// ============================================================================
// 每日复习提醒通知（notification_enabled / last_notification_date）
// ============================================================================

/**
 * 读取每日复习提醒开关。
 *
 * wire 契约：存 "true"/"false"（String(boolean)）；默认启用——
 * 只有显式存了 "false" 才视为关闭（读侧 `!== "false"`，两个消费方
 * NotificationCard/services/notifications 语义一致）。
 */
export async function getNotificationEnabled(): Promise<boolean> {
  return (await getSetting(SETTINGS_KEYS.notificationEnabled)) !== "false";
}

/** 写入每日复习提醒开关（wire 值 "true"/"false"） */
export async function setNotificationEnabled(enabled: boolean): Promise<void> {
  await setSetting(SETTINGS_KEYS.notificationEnabled, String(enabled));
}

/** 读取最近一次发送复习提醒的日期（`getLocalDate()` 本地时区 "YYYY-MM-DD"；未通知过为 null） */
export async function getLastNotificationDate(): Promise<string | null> {
  return getSetting(SETTINGS_KEYS.lastNotificationDate);
}

/** 写入最近一次发送复习提醒的日期；传 "" 显式清除（关闭提醒开关时调用，次日可重新提醒） */
export async function setLastNotificationDate(date: string): Promise<void> {
  await setSetting(SETTINGS_KEYS.lastNotificationDate, date);
}

// ============================================================================
// 数据库备份记录（last_backup_time / last_backup_path）
// ============================================================================

/** 读取上次备份时间（`new Date().toISOString()` UTC ISO 8601；从未备份为 null） */
export async function getLastBackupTime(): Promise<string | null> {
  return getSetting(SETTINGS_KEYS.lastBackupTime);
}

/** 写入上次备份时间（ISO 8601 字符串，由调用方生成） */
export async function setLastBackupTime(isoTimestamp: string): Promise<void> {
  await setSetting(SETTINGS_KEYS.lastBackupTime, isoTimestamp);
}

/** 读取上次备份目标路径（用户在保存对话框中选择的完整路径；从未备份为 null） */
export async function getLastBackupPath(): Promise<string | null> {
  return getSetting(SETTINGS_KEYS.lastBackupPath);
}

/** 写入上次备份目标路径 */
export async function setLastBackupPath(destPath: string): Promise<void> {
  await setSetting(SETTINGS_KEYS.lastBackupPath, destPath);
}

// ============================================================================
// FSRS 目标留存率（fsrs_request_retention）
// ============================================================================

/**
 * 读取 FSRS 目标留存率。
 *
 * wire 契约：十进制字符串（如 "0.8"/"0.9"/"0.95"），Rust 侧 parse 为 f64。
 * 刻意保持 string 类型而非归一化为 number——存量数据是原样字符串，
 * 封装不做"顺手规范化"，解析与 clamp 仍由调用方/Rust 负责。
 */
export async function getFsrsRequestRetention(): Promise<string | null> {
  return getSetting(SETTINGS_KEYS.fsrsRequestRetention);
}

/** 写入 FSRS 目标留存率（十进制字符串，如 "0.9"） */
export async function setFsrsRequestRetention(retention: string): Promise<void> {
  await setSetting(SETTINGS_KEYS.fsrsRequestRetention, retention);
}
