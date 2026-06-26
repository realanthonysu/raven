/**
 * 通知服务 -- 封装 Tauri 原生通知插件（tauri-plugin-notification）。
 * 用于每日复习提醒：应用启动时检查是否有待复习词汇，若有则发送系统通知。
 *
 * 通过 settings 表的 "notification_enabled" 和 "last_notification_date" 控制行为。
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getReviewStats, getSetting, setSetting } from "@/lib/db";

/**
 * 检查并发送复习提醒通知。
 *
 * 执行条件（全部满足才发送）：
 * 1. 用户在设置中启用了通知（notification_enabled !== "false"，默认启用）
 * 2. 今日尚未通知过（last_notification_date !== 今天日期）
 * 3. 存在待复习词汇（dueCount > 0）
 * 4. 系统通知权限已授予
 *
 * 调用时机：App.tsx 组件挂载时（应用启动）。
 */
export async function checkAndNotifyReview(): Promise<void> {
  try {
    // 检查用户是否启用了通知（默认启用，只有显式设为 "false" 才关闭）
    const enabled = await getSetting("notification_enabled");
    if (enabled === "false") return;

    // 检查今日是否已通知（避免同一天重复弹出）
    // 使用本地时区格式化日期，避免 UTC 时区导致跨午夜日期不一致
    const lastNotified = await getSetting("last_notification_date");
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (lastNotified === today) return;

    // 获取待复习词数
    const stats = await getReviewStats();
    if (stats.dueCount === 0) return;

    // 检查并请求原生通知权限
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }

    if (permissionGranted) {
      await setSetting("last_notification_date", today);
      sendReviewNotification(stats.dueCount);
    }
    // 如果权限被拒绝，静默处理，不打扰用户
  } catch (err) {
    // 通知流程中的异常不应影响应用启动，但仍需记录以便排查
    console.warn("[notifications] 检查或发送复习提醒失败:", err);
  }
}

/**
 * 获取当前原生通知权限状态。
 *
 * @returns 通知权限状态："granted"（已授权）或 "default"（未请求/未知）。
 *          出于安全考虑，错误时返回 "default" 而非 "denied"，避免 UI 误导用户。
 */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  try {
    const granted = await isPermissionGranted();
    return granted ? "granted" : "default";
  } catch (err) {
    console.warn("[notifications] 获取通知权限失败:", err);
    // 错误时返回 default（表示未知/未请求）而非 denied，避免 UI 误导用户为"已拒绝"
    return "default";
  }
}

/**
 * 请求原生通知权限。
 *
 * 调用 Tauri 原生通知插件的权限请求接口，弹出系统权限对话框。
 * 首次调用时系统会弹窗询问用户，后续调用返回已缓存的授权结果。
 *
 * @returns 最终的权限状态："granted"（已授权）或 "denied"（已拒绝）
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return requestPermission();
}

/**
 * 发送复习提醒通知。
 * @param dueCount - 待复习词汇数量
 */
function sendReviewNotification(dueCount: number): void {
  sendNotification({
    title: "Raven 英语学习",
    body: `你有 ${dueCount} 个生词待复习，点击打开应用开始学习。`,
  });
}
