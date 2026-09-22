/** 数据库备份/恢复卡片 —— SQLite backup API 导出完整数据库副本，支持从备份恢复。 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { Database, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { backupDatabase, getSetting, restoreDatabase, setSetting } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";

interface BackupCardProps {
  onError: (msg: string) => void;
}

export function BackupCard({ onError }: BackupCardProps) {
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  useEffect(() => {
    getSetting("last_backup_time")
      .then(setLastBackupTime)
      .catch((err) => console.warn("load last_backup_time failed", err));
    getSetting("last_backup_path")
      .then(setLastBackupPath)
      .catch((err) => console.warn("load last_backup_path failed", err));
  }, []);

  async function handleBackup() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const destPath = await save({
      title: "备份数据库",
      defaultPath: `raven-backup-${dateStr}_${timeStr}.db`,
      filters: [{ name: "SQLite Database", extensions: ["db"] }],
    });
    if (!destPath) return;

    setBackingUp(true);
    try {
      await backupDatabase(destPath);
      const isoNow = now.toISOString();
      await setSetting("last_backup_time", isoNow);
      await setSetting("last_backup_path", destPath);
      setLastBackupTime(isoNow);
      setLastBackupPath(destPath);
    } catch (err) {
      console.error("Backup failed:", err);
      onError(`备份失败：${getErrorMessage(err)}`);
    } finally {
      setBackingUp(false);
    }
  }

  async function handleRestore() {
    const sourcePath = await open({
      title: "选择备份文件",
      multiple: false,
      filters: [{ name: "SQLite Database", extensions: ["db"] }],
    });
    if (!sourcePath || Array.isArray(sourcePath)) return;

    const confirmed = window.confirm(
      "恢复备份将覆盖当前全部学习数据（生词、历史、设置），且不可撤销。确定继续吗？",
    );
    if (!confirmed) return;

    setRestoring(true);
    setRestoreMsg(null);
    try {
      await restoreDatabase(sourcePath);
      setRestoreMsg("恢复成功。建议重启应用以确保所有模块加载最新数据。");
    } catch (err) {
      console.error("Restore failed:", err);
      onError(`恢复失败：${getErrorMessage(err)}`);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>数据备份</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">备份数据库</p>
              <p className="text-sm text-muted-foreground">
                使用 SQLite backup API 导出完整数据库副本
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={handleBackup} disabled={backingUp}>
            {backingUp ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                备份中...
              </>
            ) : (
              <>
                <Database className="h-4 w-4 mr-2" />
                选择位置并备份
              </>
            )}
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RotateCcw className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">恢复数据库</p>
              <p className="text-sm text-muted-foreground">
                从备份文件恢复（覆盖当前数据，换机/重装后使用）
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={handleRestore}
            disabled={restoring}
            className="text-destructive border-destructive/40 hover:bg-destructive/10"
          >
            {restoring ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                恢复中...
              </>
            ) : (
              <>
                <RotateCcw className="h-4 w-4 mr-2" />
                选择备份并恢复
              </>
            )}
          </Button>
        </div>
        {restoreMsg && <p className="text-sm text-green-600 dark:text-green-400">{restoreMsg}</p>}

        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground space-y-1">
          {lastBackupTime ? (
            <>
              <p>上次备份：{new Date(lastBackupTime).toLocaleString()}</p>
              {lastBackupPath && (
                <p className="truncate" title={lastBackupPath}>
                  路径：{lastBackupPath}
                </p>
              )}
            </>
          ) : (
            <p>暂无备份记录</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
