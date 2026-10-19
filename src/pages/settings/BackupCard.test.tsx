import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

// 部分 mock：IPC 函数替换为 vi.fn()，getLocalDate 等纯函数走真实实现——
// 备份/快照文件名的本地日期语义若漂移，本测试第一时间可见
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  backupDatabaseDialog: vi.fn(),
  backupDatabaseDefault: vi.fn(),
  restoreDatabase: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// 重载单独 mock：断言"恢复成功后短延迟重载"而不触发 jsdom 真实导航
const mockReloadApp = vi.fn();

vi.mock("@/lib/reload-app", () => ({
  reloadApp: (...args: unknown[]) => mockReloadApp(...args),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

import { open } from "@tauri-apps/plugin-dialog";
import {
  backupDatabaseDefault,
  backupDatabaseDialog,
  getSetting,
  restoreDatabase,
  setSetting,
} from "@/lib/db";
import { BackupCard } from "./BackupCard";

const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);
const mockBackupDatabaseDialog = vi.mocked(backupDatabaseDialog);
const mockBackupDatabaseDefault = vi.mocked(backupDatabaseDefault);
const mockRestoreDatabase = vi.mocked(restoreDatabase);
const mockOpen = vi.mocked(open);

function renderBackupCard(onError = vi.fn()) {
  return render(<BackupCard onError={onError} />);
}

describe("BackupCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined as never);
    mockBackupDatabaseDialog.mockResolvedValue("C:\\backups\\raven-backup.db");
    mockBackupDatabaseDefault.mockResolvedValue("C:\\Users\\x\\Documents\\Raven\\snapshot.db");
    mockRestoreDatabase.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    // 恢复成功的用例会排定重载定时器：shouldAdvanceTime 下若不清理，
    // 泄漏的定时器会在后续用例中误触发 reloadApp
    vi.clearAllTimers();
  });

  it('renders "数据备份" title', async () => {
    renderBackupCard();
    expect(screen.getByText("数据备份")).toBeInTheDocument();
  });

  it("shows backup button", async () => {
    renderBackupCard();
    expect(screen.getByText("选择位置并备份")).toBeInTheDocument();
  });

  it('shows "暂无备份记录" when no previous backup', async () => {
    renderBackupCard();
    await waitFor(() => {
      expect(screen.getByText("暂无备份记录")).toBeInTheDocument();
    });
  });

  it("shows last backup info when backup record exists", async () => {
    const backupTime = "2026-07-27T10:00:00.000Z";
    const backupPath = "/path/to/backup.db";
    mockGetSetting.mockImplementation((key: string) => {
      if (key === "last_backup_time") return Promise.resolve(backupTime);
      if (key === "last_backup_path") return Promise.resolve(backupPath);
      return Promise.resolve(null);
    });

    renderBackupCard();

    await waitFor(() => {
      expect(screen.getByText(/上次备份/)).toBeInTheDocument();
    });
    expect(screen.getByText(/路径.*\/path\/to\/backup\.db/)).toBeInTheDocument();
  });

  it("performs backup via the Rust-side dialog wrapper", async () => {
    const destPath = "D:\\usb-drive\\raven-backup.db"; // 写路径白名单外的位置同样可用
    mockBackupDatabaseDialog.mockResolvedValue(destPath);

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockBackupDatabaseDialog).toHaveBeenCalledWith(
        expect.stringMatching(/^raven-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/),
      );
    });

    expect(mockSetSetting).toHaveBeenCalledWith("last_backup_time", expect.any(String));
    expect(mockSetSetting).toHaveBeenCalledWith("last_backup_path", destPath);
  });

  it("names the backup file with the local date via getLocalDate (C2)", async () => {
    // 备份文件名的日期部分统一走 getLocalDate（本地时区，YYYY-MM-DD），
    // 时-分-秒保留 pad —— 与导出命名、恢复前快照命名同源
    vi.setSystemTime(new Date(2026, 9, 14, 2, 0, 0)); // 本地 2026-10-14 02:00

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockBackupDatabaseDialog).toHaveBeenCalled();
    });
    // 钉死本地日期 2026-10-14 与整体格式；时-分-秒允许测试执行期间的正常滚动
    expect(mockBackupDatabaseDialog).toHaveBeenCalledWith(
      expect.stringMatching(/^raven-backup-2026-10-14_\d{2}-\d{2}-\d{2}\.db$/),
    );
  });

  it("does nothing when user cancels the backup dialog", async () => {
    mockBackupDatabaseDialog.mockResolvedValue(null);

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockBackupDatabaseDialog).toHaveBeenCalled();
    });

    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("calls onError when backup fails", async () => {
    const onError = vi.fn();
    mockBackupDatabaseDialog.mockRejectedValue(new Error("disk full"));

    renderBackupCard(onError);

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("备份失败"));
    });
  });

  // ── 恢复：确认流程 / 快照 / 重载 ──────────────────────────────────

  it("does nothing when user cancels the file picker", async () => {
    mockOpen.mockResolvedValue(null);

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });

    expect(mockBackupDatabaseDefault).not.toHaveBeenCalled();
    expect(mockRestoreDatabase).not.toHaveBeenCalled();
  });

  it("snapshots to the default location before restoring", async () => {
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup-2026-01-01.db");

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));

    await waitFor(() => {
      expect(mockBackupDatabaseDefault).toHaveBeenCalledWith(
        expect.stringMatching(/^raven-pre-restore-\d{8}-\d{6}\.db$/),
      );
    });
    // 确认对话框出现后才真正恢复
    expect(screen.getByText("确认恢复")).toBeInTheDocument();
    expect(mockRestoreDatabase).not.toHaveBeenCalled();
  });

  it("restores from the picked file after confirmation", async () => {
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup.db");

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));
    await waitFor(() => {
      expect(screen.getByText("确认恢复")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("恢复"));

    await waitFor(() => {
      expect(mockRestoreDatabase).toHaveBeenCalledWith("D:\\backups\\raven-backup.db");
    });
  });

  it("shows the snapshot-fail confirmation when the snapshot fails", async () => {
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup.db");
    mockBackupDatabaseDefault.mockRejectedValue(new Error("disk full"));

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));

    await waitFor(() => {
      expect(screen.getByText("快照失败")).toBeInTheDocument();
    });
    expect(screen.getByText(/恢复前自动快照失败/)).toBeInTheDocument();

    // 取消确认：不恢复
    fireEvent.click(screen.getByText("取消"));
    expect(mockRestoreDatabase).not.toHaveBeenCalled();
  });

  it("proceeds with restore after confirming despite snapshot failure", async () => {
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup.db");
    mockBackupDatabaseDefault.mockRejectedValue(new Error("disk full"));

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));
    await waitFor(() => {
      expect(screen.getByText("仍要恢复")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("仍要恢复"));

    await waitFor(() => {
      expect(mockRestoreDatabase).toHaveBeenCalledWith("D:\\backups\\raven-backup.db");
    });
  });

  it("calls onError when restore fails", async () => {
    const onError = vi.fn();
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup.db");
    mockRestoreDatabase.mockRejectedValue(new Error("corrupt file"));

    renderBackupCard(onError);

    fireEvent.click(screen.getByText("选择备份并恢复"));
    await waitFor(() => {
      expect(screen.getByText("确认恢复")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("恢复"));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("恢复失败"));
    });
    expect(mockReloadApp).not.toHaveBeenCalled();
  });

  it("reloads the app after a short delay on successful restore", async () => {
    mockOpen.mockResolvedValue("D:\\backups\\raven-backup.db");

    renderBackupCard();

    fireEvent.click(screen.getByText("选择备份并恢复"));
    await waitFor(() => {
      expect(screen.getByText("确认恢复")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("恢复"));

    // 成功消息先渲染（重载前的用户反馈）
    await waitFor(() => {
      expect(screen.getByText("恢复成功，正在重新加载应用…")).toBeInTheDocument();
    });
    // 重载是短延迟而非立即执行
    expect(mockReloadApp).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockReloadApp).toHaveBeenCalledOnce();
  });
});
