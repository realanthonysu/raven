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

/** 写入文本内容到指定文件路径 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("db_write_text_file", { path, content });
}

/** 备份数据库文件到指定路径（使用 SQLite backup API） */
export async function backupDatabase(destPath: string): Promise<void> {
  return invoke<void>("db_backup_db", { destPath });
}
