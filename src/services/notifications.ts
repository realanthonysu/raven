/**
 * 通知服务 -- 封装浏览器原生 Notification API。
 * 用于每日复习提醒：应用启动时检查是否有待复习词汇，若有则发送系统通知。
 *
 * 使用浏览器 Notification API（Tauri WebView2 原生支持），无需额外插件。
 * 通过 settings 表的 "notification_enabled" 和 "last_notification_date" 控制行为。
 */
import { getReviewStats, getSetting, setSetting } from "@/lib/db";

/**
 * 检查并发送复习提醒通知。
 *
 * 执行条件（全部满足才发送）：
 * 1. 用户在设置中启用了通知（notification_enabled !== "false"，默认启用）
 * 2. 今日尚未通知过（last_notification_date !== 今天日期）
 * 3. 存在待复习词汇（dueCount > 0）
 * 4. 浏览器 Notification 权限已授予
 *
 * 调用时机：App.tsx 组件挂载时（应用启动）。
 */
export async function checkAndNotifyReview(): Promise<void> {
  try {
    // 检查用户是否启用了通知（默认启用，只有显式设为 "false" 才关闭）
    const enabled = await getSetting("notification_enabled");
    if (enabled === "false") return;

    // 检查今日是否已通知（避免同一天重复弹出）
    const lastNotified = await getSetting("last_notification_date");
    const today = new Date().toISOString().split("T")[0];
    if (lastNotified === today) return;

    // 获取待复习词数
    const stats = await getReviewStats();
    if (stats.dueCount === 0) return;

    // 检查并请求通知权限
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
      sendReviewNotification(stats.dueCount);
      await setSetting("last_notification_date", today);
    } else if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        sendReviewNotification(stats.dueCount);
        await setSetting("last_notification_date", today);
      }
    }
    // 如果权限被拒绝，静默处理，不打扰用户
  } catch {
    // 通知流程中任何异常都静默处理，不影响应用正常启动
  }
}

/**
 * 发送复习提醒通知。
 * @param dueCount - 待复习词汇数量
 */
function sendReviewNotification(dueCount: number): void {
  new Notification("Raven 英语学习", {
    body: `你有 ${dueCount} 个生词待复习，点击打开应用开始学习。`,
    icon: undefined, // WebView2 中 icon 路径不可靠，使用默认图标
  });
}
