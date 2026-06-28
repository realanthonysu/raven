/** 通知设置卡片 —— 每日复习提醒开关、系统通知权限管理。 */

import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { getSetting, setSetting } from "@/lib/db";
import { getNotificationPermission, requestNotificationPermission } from "@/services/notifications";

interface NotificationCardProps {
  onError: (msg: string) => void;
}

export function NotificationCard({ onError }: NotificationCardProps) {
  const [enabled, setEnabled] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>("default");

  useEffect(() => {
    getSetting("notification_enabled")
      .then((val) => setEnabled(val !== "false"))
      .catch((err) => console.warn("load notification_enabled failed", err));
    getNotificationPermission()
      .then(setPermission)
      .catch((err) => console.warn("load notification permission failed", err));
  }, []);

  async function handleToggle(checked: boolean) {
    const prev = enabled;
    setEnabled(checked);
    try {
      await setSetting("notification_enabled", String(checked));
      if (!checked) {
        await setSetting("last_notification_date", "");
      }
    } catch (err) {
      setEnabled(prev);
      onError(`更新通知设置失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  async function handleRequestPermission() {
    try {
      const perm = await requestNotificationPermission();
      setPermission(perm);
      if (perm === "denied") {
        onError("通知权限已被拒绝，请在系统设置中手动开启");
      }
    } catch (err) {
      onError(`请求通知权限失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知设置</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">每日复习提醒</p>
              <p className="text-sm text-muted-foreground">
                应用启动时检查待复习词汇并发送 Windows 原生通知
              </p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={handleToggle} />
        </div>
        <div className="mt-3 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <span>
            通知权限：
            {permission === "granted"
              ? "已授权"
              : permission === "denied"
                ? "已拒绝（请在系统通知设置中为 Raven 开启）"
                : "未请求"}
          </span>
          {permission === "default" && (
            <Button variant="ghost" size="sm" onClick={handleRequestPermission}>
              请求权限
            </Button>
          )}
        </div>
        {import.meta.env.DEV && (
          <p className="mt-2 text-xs text-muted-foreground">
            提示：开发模式下通知权限由 WebView2 管理，Raven
            不会出现在系统通知设置列表中。正式版需安装后才会注册。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
