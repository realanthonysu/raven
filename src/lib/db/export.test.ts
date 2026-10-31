import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupDatabaseDefault,
  backupDatabaseDialog,
  exportWordsAnki,
  exportWordsCsv,
  exportWordsDialog,
  restoreDatabase,
  writeTextFileDialog,
} from "./export";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("export db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exportWordsCsv invokes the legacy CSV command", async () => {
    vi.mocked(invoke).mockResolvedValue("word,phonetic\nhello,/həˈloʊ/");
    const result = await exportWordsCsv();
    expect(invoke).toHaveBeenCalledWith("db_export_words_csv");
    expect(result).toContain("hello");
  });

  it("exportWordsAnki invokes the legacy Anki command", async () => {
    vi.mocked(invoke).mockResolvedValue("hello\t/həˈloʊ/");
    const result = await exportWordsAnki();
    expect(invoke).toHaveBeenCalledWith("db_export_words_anki");
    expect(result).toContain("hello");
  });

  // ── D-08：单次 IPC 的对话框导出 ──

  it("exportWordsDialog passes the kind and returns the written path", async () => {
    vi.mocked(invoke).mockResolvedValue("C:\\exports\\raven-words-2026-01-01.csv");
    const result = await exportWordsDialog("csv");
    // Rust 侧完成查库/生成/弹窗/写盘，前端只发一个 kind 并拿回路径
    expect(invoke).toHaveBeenCalledWith("db_export_words_dialog", { kind: "csv" });
    expect(result).toBe("C:\\exports\\raven-words-2026-01-01.csv");
  });

  it("exportWordsDialog supports the anki kind", async () => {
    vi.mocked(invoke).mockResolvedValue("/tmp/raven-words-2026-01-01.txt");
    await exportWordsDialog("anki");
    expect(invoke).toHaveBeenCalledWith("db_export_words_dialog", { kind: "anki" });
  });

  it("exportWordsDialog maps a cancelled dialog to null", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await exportWordsDialog("csv");
    expect(result).toBeNull();
  });

  it("writeTextFileDialog still forwards default name/extension/content", async () => {
    vi.mocked(invoke).mockResolvedValue("C:\\exports\\note.txt");
    await writeTextFileDialog("note.txt", "txt", "hello");
    expect(invoke).toHaveBeenCalledWith("write_text_file_dialog", {
      defaultFileName: "note.txt",
      extension: "txt",
      content: "hello",
    });
  });

  it("backupDatabaseDialog returns null when the user cancels", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await backupDatabaseDialog("raven.db");
    expect(invoke).toHaveBeenCalledWith("db_backup_db_dialog", { defaultFileName: "raven.db" });
    expect(result).toBeNull();
  });

  it("backupDatabaseDefault returns the snapshot path", async () => {
    vi.mocked(invoke).mockResolvedValue("C:\\Users\\me\\Documents\\Raven\\snapshot.db");
    await backupDatabaseDefault("snapshot.db");
    expect(invoke).toHaveBeenCalledWith("db_backup_db_default", {
      defaultFileName: "snapshot.db",
    });
  });

  it("restoreDatabase passes the source path", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await restoreDatabase("C:\\backups\\raven.db");
    expect(invoke).toHaveBeenCalledWith("db_restore_db", {
      sourcePath: "C:\\backups\\raven.db",
    });
  });
});
