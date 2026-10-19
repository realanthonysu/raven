/**
 * 导出与备份操作。
 */

import { invoke } from "@tauri-apps/api/core";

/** 导出所有生词为 CSV 格式字符串 */
export async function exportWordsCsv(): Promise<string> {
  return invoke<string>("db_export_words_csv");
}

/** 导出所有生词为 Anki 导入格式（Tab 分隔） */
export async function exportWordsAnki(): Promise<string> {
  return invoke<string>("db_export_words_anki");
}

/** 写入文本内容到指定文件路径（仅白名单内路径，内部/兼容用途） */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

/**
 * 导出文本内容：由 Rust 侧弹出原生保存对话框并直接写入。
 * 用户任选位置（U 盘/网络共享等白名单外路径同样可用），取消时返回 null。
 */
export async function writeTextFileDialog(
  defaultFileName: string,
  extension: string,
  content: string,
): Promise<string | null> {
  return invoke<string | null>("write_text_file_dialog", {
    defaultFileName,
    extension,
    content,
  });
}

/** 备份数据库文件到指定路径（使用 SQLite backup API） */
export async function backupDatabase(destPath: string): Promise<void> {
  return invoke<void>("db_backup_db", { destPath });
}

/**
 * 备份数据库：由 Rust 侧弹出原生保存对话框并直接写入。
 * 用户任选位置，取消时返回 null；成功返回实际写入路径。
 */
export async function backupDatabaseDialog(defaultFileName: string): Promise<string | null> {
  return invoke<string | null>("db_backup_db_dialog", { defaultFileName });
}

/**
 * 备份数据库到默认位置（Documents/Raven，不存在则创建），返回实际写入路径。
 * 供恢复前自动快照使用：快照不跟随用户选择的任意备份目录。
 */
export async function backupDatabaseDefault(defaultFileName: string): Promise<string> {
  return invoke<string>("db_backup_db_default", { defaultFileName });
}

/** 从备份文件恢复数据库（破坏性：覆盖当前数据，前端须先确认）。 */
export async function restoreDatabase(sourcePath: string): Promise<void> {
  return invoke<void>("db_restore_db", { sourcePath });
}
