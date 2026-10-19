/** 数据库备份/恢复卡片 —— SQLite backup API 导出完整数据库副本，支持从备份恢复。 */

import { open } from "@tauri-apps/plugin-dialog";
import { Database, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  backupDatabaseDefault,
  backupDatabaseDialog,
  getLocalDate,
  getSetting,
  restoreDatabase,
  setSetting,
} from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { reloadApp } from "@/lib/reload-app";

type PendingConfirm = { kind: "snapshot-fail"; message: string } | { kind: "restore" } | null;

/**
 * 恢复成功后到重载之间的延迟：让"恢复成功，正在重新加载应用…"先渲染一帧，
 * 再 reload 重新 hydration 全部内存态（默认模型 / TTS / 级别 store / 上下文缓存）。
 */
const RELOAD_DELAY_MS = 1500;

interface BackupCardProps {
  onError: (msg: string) => void;
}

export function BackupCard({ onError }: BackupCardProps) {
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const pendingSourceRef = useRef<string | null>(null);

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
    // 日期部分复用 getLocalDate（本地时区），时-分-秒保留 pad —— 与恢复前快照命名同源
    const dateStr = getLocalDate(now);
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    setBackingUp(true);
    try {
      // 由 Rust 侧弹出原生保存对话框并直接写入：用户可任选位置（U 盘/网络共享等
      // 写路径白名单外目标同样可用），取消时返回 null
      const destPath = await backupDatabaseDialog(`raven-backup-${dateStr}_${timeStr}.db`);
      if (!destPath) return;
      // 写入已在 Rust 侧完成，这里只登记备份记录
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
    pendingSourceRef.current = sourcePath;

    // 恢复前自动快照当前库：写入默认位置（Documents/Raven），不跟随用户选择的
    // 备份目录，避免快照与被恢复文件同目录互相覆盖
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // 日期部分复用 getLocalDate（本地时区，YYYYMMDD），与 handleBackup 的命名同源
    const stamp = `${getLocalDate(now).replace(/-/g, "")}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const snapshotName = `raven-pre-restore-${stamp}.db`;
    try {
      await backupDatabaseDefault(snapshotName);
    } catch (err) {
      setPendingConfirm({
        kind: "snapshot-fail",
        message: `恢复前自动快照失败：${getErrorMessage(err)}`,
      });
      return;
    }
    setPendingConfirm({ kind: "restore" });
  }

  async function runRestore() {
    const sourcePath = pendingSourceRef.current;
    if (!sourcePath) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      await restoreDatabase(sourcePath);
      setRestoreMsg("恢复成功，正在重新加载应用…");
      // 内存缓存（默认模型 / TTS / 个性化上下文 / 级别 store）仍指向旧库，
      // 重载应用统一重新初始化，彻底消除新旧数据混读
      setTimeout(reloadApp, RELOAD_DELAY_MS);
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

        <ConfirmDialog
          open={pendingConfirm !== null}
          title={pendingConfirm?.kind === "snapshot-fail" ? "快照失败" : "确认恢复"}
          description={
            pendingConfirm?.kind === "snapshot-fail"
              ? `${pendingConfirm.message}\n\n仍要继续恢复吗？（不推荐）`
              : "恢复将覆盖当前全部学习数据（生词、历史、设置）。已尝试自动快照。"
          }
          confirmLabel={pendingConfirm?.kind === "snapshot-fail" ? "仍要恢复" : "恢复"}
          destructive
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            setPendingConfirm(null);
            void runRestore();
          }}
        />
      </CardContent>
    </Card>
  );
}
