import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

// 部分 mock：IPC 函数替换为 vi.fn()，getLocalDate 等纯函数走真实实现——
// 备份/快照文件名的本地日期语义若漂移，本测试第一时间可见
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  backupDatabase: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { backupDatabase, getSetting, setSetting } from "@/lib/db";
import { BackupCard } from "./BackupCard";

const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);
const mockBackupDatabase = vi.mocked(backupDatabase);
const mockSave = vi.mocked(save);

function renderBackupCard(onError = vi.fn()) {
  return render(<BackupCard onError={onError} />);
}

describe("BackupCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined as never);
    mockBackupDatabase.mockResolvedValue(undefined as never);
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

  it("performs backup when user selects a destination", async () => {
    const destPath = "C:\\backups\\raven-backup.db";
    mockSave.mockResolvedValue(destPath);

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockBackupDatabase).toHaveBeenCalledWith(destPath);
    });

    expect(mockSetSetting).toHaveBeenCalledWith("last_backup_time", expect.any(String));
    expect(mockSetSetting).toHaveBeenCalledWith("last_backup_path", destPath);
  });

  it("names the backup file with the local date via getLocalDate (C2)", async () => {
    // 备份文件名的日期部分统一走 getLocalDate（本地时区，YYYY-MM-DD），
    // 时-分-秒保留 pad —— 与导出命名、恢复前快照命名同源
    vi.setSystemTime(new Date(2026, 9, 14, 2, 0, 0)); // 本地 2026-10-14 02:00
    mockSave.mockResolvedValue("C:\\backups\\raven-backup.db");

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockBackupDatabase).toHaveBeenCalled();
    });
    // 钉死本地日期 2026-10-14 与整体格式；时-分-秒允许测试执行期间的正常滚动
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^raven-backup-2026-10-14_\d{2}-\d{2}-\d{2}\.db$/),
      }),
    );
  });

  it("does nothing when user cancels save dialog", async () => {
    mockSave.mockResolvedValue(null);

    renderBackupCard();

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled();
    });

    expect(mockBackupDatabase).not.toHaveBeenCalled();
  });

  it("calls onError when backup fails", async () => {
    const onError = vi.fn();
    mockSave.mockResolvedValue("C:\\backups\\test.db");
    mockBackupDatabase.mockRejectedValue(new Error("disk full"));

    renderBackupCard(onError);

    fireEvent.click(screen.getByText("选择位置并备份"));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("备份失败"));
    });
  });
});
